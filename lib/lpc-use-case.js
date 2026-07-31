'use strict';

const path = require('node:path');
const StateMachine = require('javascript-state-machine');
const { makeClient, callUnary } = require('./grpc-cslpc');
const { EebusEnergyGuard, ManualEnergyGuard } = require('./energy-guard');
const { addEntity, addCsLpcUseCase, subscribeCsLpcEvents, registerRemoteSki } = require('./grpc-service');

/**
 * Root directory for protobuf definitions.
 */
const PROTO_DIR = path.join(__dirname, 'protobuf');

/**
 * LPC states as defined in EEBus UC TS - Limitation of Power Consumption §2.3.2
 */
const LPC_STATE = Object.freeze({
    INIT: 'init',
    UNLIMITED_CONTROLLED: 'unlimitedControlled',
    LIMITED: 'limited',
    FAILSAFE: 'failsafe',
    UNLIMITED_AUTONOMOUS: 'unlimitedAutonomous',
});

/**
 * FSM transition table for the LPC use case.
 * Each entry maps { name, from, to } per EEBus UC TS §2.3.3.
 */
const LPC_TRANSITIONS = Object.freeze([
    // T1: init → unlimitedControlled
    { name: 'heartbeatDeactivatedLimit', from: LPC_STATE.INIT, to: LPC_STATE.UNLIMITED_CONTROLLED },
    { name: 'heartbeatLimitNotApplicable', from: LPC_STATE.INIT, to: LPC_STATE.UNLIMITED_CONTROLLED },

    // T2: init → limited
    { name: 'heartbeatActivatedLimit', from: LPC_STATE.INIT, to: LPC_STATE.LIMITED },

    // T3: init → unlimitedAutonomous
    { name: 'initTimeout', from: LPC_STATE.INIT, to: LPC_STATE.UNLIMITED_AUTONOMOUS },

    // T4: unlimitedControlled → limited
    { name: 'heartbeatActivatedLimit', from: LPC_STATE.UNLIMITED_CONTROLLED, to: LPC_STATE.LIMITED },

    // T5: unlimitedControlled → failsafe
    { name: 'heartbeatTimeout', from: LPC_STATE.UNLIMITED_CONTROLLED, to: LPC_STATE.FAILSAFE },

    // T6: limited → unlimitedControlled
    { name: 'limitDurationExpired', from: LPC_STATE.LIMITED, to: LPC_STATE.UNLIMITED_CONTROLLED },
    { name: 'heartbeatDeactivatedLimit', from: LPC_STATE.LIMITED, to: LPC_STATE.UNLIMITED_CONTROLLED },
    { name: 'heartbeatLimitNotApplicable', from: LPC_STATE.LIMITED, to: LPC_STATE.UNLIMITED_CONTROLLED },

    // T7: limited → failsafe
    { name: 'heartbeatTimeout', from: LPC_STATE.LIMITED, to: LPC_STATE.FAILSAFE },

    // T8: failsafe → unlimitedControlled
    { name: 'heartbeatDeactivatedLimit', from: LPC_STATE.FAILSAFE, to: LPC_STATE.UNLIMITED_CONTROLLED },
    { name: 'heartbeatLimitNotApplicable', from: LPC_STATE.FAILSAFE, to: LPC_STATE.UNLIMITED_CONTROLLED },

    // T9: failsafe → limited
    { name: 'heartbeatActivatedLimit', from: LPC_STATE.FAILSAFE, to: LPC_STATE.LIMITED },

    // T10: failsafe → unlimitedAutonomous
    { name: 'failsafeDurationExpired', from: LPC_STATE.FAILSAFE, to: LPC_STATE.UNLIMITED_AUTONOMOUS },
    { name: 'heartbeatNoFollowingLimit', from: LPC_STATE.FAILSAFE, to: LPC_STATE.UNLIMITED_AUTONOMOUS },

    // T11: unlimitedAutonomous → unlimitedControlled
    { name: 'heartbeatDeactivatedLimit', from: LPC_STATE.UNLIMITED_AUTONOMOUS, to: LPC_STATE.UNLIMITED_CONTROLLED },
    {
        name: 'heartbeatLimitNotApplicable',
        from: LPC_STATE.UNLIMITED_AUTONOMOUS,
        to: LPC_STATE.UNLIMITED_CONTROLLED,
    },

    // T12: unlimitedAutonomous → limited
    { name: 'heartbeatActivatedLimit', from: LPC_STATE.UNLIMITED_AUTONOMOUS, to: LPC_STATE.LIMITED },

    // T0: any → init (restart)
    { name: 'restart', from: '*', to: LPC_STATE.INIT },
]);

/**
 * LPC Use Case class encapsulating the Limitation of Power Consumption finite state machine.
 *
 * States (§2.3.2):
 *  - init: CS starts here after (re)start, limited by failsafe power limit
 *  - unlimitedControlled: CS not limited, but controlled by Energy Guard
 *  - limited: CS in limited state, controlled by Energy Guard
 *  - failsafe: CS not controlled by Energy Guard, limited by failsafe limit
 *  - unlimitedAutonomous: CS not limited, consumes as if no external limitation exists
 *
 * This class manages:
 *  - FSM transitions
 *  - CS-LPC client creation and configuration (consumption limit, failsafe, nominal max)
 *  - CS-LPC event subscription and handling
 *  - EG-LPC guard initialization, event streams, distribution
 *  - Manual consumption limit handling on EEBUS guards
 *  - Timer management (init timeout, failsafe duration, limit duration, failsafe heartbeat)
 */
class LpcUseCase {
    #adapter;
    #config;
    #controlClient;
    #translate;
    #csLpcClient;
    #fsm;
    #initTimer;
    #failsafeTimer;
    #failsafeHeartbeatTimer;
    #limitDurationTimer;
    #lpcStream;
    #guards;
    #egLpcEndpoints;
    #lastLimitActive;
    #controlBoxConnected;
    #limitMinutesToday;
    #limitActiveStartTime;
    #limitMinutesAccumTimer;
    #midnightResetTimer;
    #manualLimitTimers;

    /**
     * Create a new LpcUseCase instance.
     *
     * @param {object} adapter - ioBroker adapter instance (provides config, log, setState, setTimeout, etc.)
     * @param {object} config - Adapter configuration (native object)
     * @param {object} controlClient - gRPC ControlService client (shared with HEMS coordinator)
     * @param {(key: string) => string} translate - I18n translate function
     */
    constructor(adapter, config, controlClient, translate) {
        this.#adapter = adapter;
        this.#config = config;
        this.#controlClient = controlClient;
        this.#translate = translate || (key => key);
        this.#csLpcClient = null;
        this.#initTimer = null;
        this.#failsafeTimer = null;
        this.#failsafeHeartbeatTimer = null;
        this.#limitDurationTimer = null;
        this.#lpcStream = null;
        this.#guards = [];
        this.#egLpcEndpoints = new Map();
        this.#lastLimitActive = false;
        this.#controlBoxConnected = false;
        this.#limitMinutesToday = 0;
        this.#limitActiveStartTime = null;
        this.#limitMinutesAccumTimer = null;
        this.#midnightResetTimer = null;
        this.#manualLimitTimers = new Map();

        this.#fsm = new StateMachine({
            init: LPC_STATE.INIT,
            transitions: LPC_TRANSITIONS,
            methods: {
                onEnterState: lifecycle => {
                    this.#onEnterState(lifecycle);
                },
                onLeaveState: lifecycle => {
                    this.#onLeaveState(lifecycle);
                },
            },
        });
    }

    // ─── Public Interface ────────────────────────────────────────────────

    /**
     * Current state of the LPC FSM.
     *
     * @returns {string} One of the LPC_STATE constants
     */
    get state() {
        return this.#fsm.state;
    }

    /**
     * Start the LPC use case.
     * Registers CS-LPC use case, creates clients, subscribes to events, and initializes guards.
     */
    async start() {
        const log = this.#adapter.log;
        log.info('LPC use case starting');

        // Create "LPC" folder at adapter namespace root (Requirement 10.1)
        await this.#adapter.extendObjectAsync('LPC', {
            type: 'folder',
            common: { name: 'LPC' },
            native: {},
        });

        // Create LPC state objects (Requirement 10.2)
        await this.#adapter.extendObjectAsync('LPC.state', {
            type: 'state',
            common: {
                name: 'State',
                type: 'string',
                role: 'text',
                def: 'init',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.#adapter.extendObjectAsync('LPC.limit', {
            type: 'state',
            common: {
                name: 'Limit',
                type: 'number',
                role: 'value.power',
                unit: 'W',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });
        await this.#adapter.extendObjectAsync('LPC.limitDuration', {
            type: 'state',
            common: {
                name: 'Limit Duration',
                type: 'number',
                role: 'value',
                unit: 'min',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });
        await this.#adapter.extendObjectAsync('LPC.limitMinutesToday', {
            type: 'state',
            common: {
                name: 'Limit Minutes Today',
                type: 'number',
                role: 'value',
                unit: 'min',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });

        // Register CS-LPC use case at entity address [1]
        let csLpcEndpoint;
        try {
            csLpcEndpoint = await addCsLpcUseCase(this.#controlClient, [1]);
        } catch (err) {
            log.error(`Failed to register CS-LPC use case: ${err.message}`);
            this.#startInitTimer();
            return;
        }

        // Handle empty endpoint: treat as failed registration
        if (!csLpcEndpoint) {
            log.error('CS-LPC use case registration returned empty endpoint — skipping LPC client creation');
            this.#startInitTimer();
            return;
        }

        log.info(`CS-LPC UseCase added with endpoint: ${csLpcEndpoint}`);

        // Create CS-LPC gRPC client at the returned endpoint
        this.#csLpcClient = makeClient({
            protoDir: PROTO_DIR,
            protoRelPath: 'usecases/cs/lpc/service.proto',
            pkg: 'cs_lpc',
            service: 'ControllableSystemLPCControl',
            endpoint: csLpcEndpoint,
        });

        // Configure initial parameters
        const nominalMax = this.#config.contractualConsumptionNominalMax || 32000;
        await callUnary(this.#csLpcClient, 'SetConsumptionNominalMax', { value: nominalMax });
        await callUnary(this.#csLpcClient, 'SetConsumptionLimit', {
            load_limit: {
                is_changeable: true,
                is_active: false,
                value: 4200,
            },
        });
        await callUnary(this.#csLpcClient, 'SetFailsafeConsumptionActivePowerLimit', {
            value: 4200,
            is_changeable: false,
        });
        await callUnary(this.#csLpcClient, 'SetFailsafeDurationMinimum', {
            is_changeable: false,
            duration_nanoseconds: 2 * 3600 * 1000000000, // 2h in ns
        });

        log.info('CS-LPC client configured with initial parameters');

        // Subscribe to CS-LPC events
        this.#subscribeCsLpcEvents();

        // Initialize LPC energy guards
        await this.#initEnergyGuards();

        this.#startInitTimer();
    }

    /**
     * Stop the LPC use case, cleaning up all resources.
     * Cancels all timers, closes streams and clients.
     */
    stop() {
        this.#clearInitTimer();
        this.#clearFailsafeTimer();
        this.#clearFailsafeHeartbeatTimer();
        this.#clearLimitDurationTimer();
        // Cancel all manual limit timers
        for (const timer of this.#manualLimitTimers.values()) {
            this.#adapter.clearTimeout(timer);
        }
        this.#manualLimitTimers.clear();
        // Cancel limit tracking timers
        if (this.#limitMinutesAccumTimer) {
            this.#adapter.clearInterval(this.#limitMinutesAccumTimer);
            this.#limitMinutesAccumTimer = null;
        }
        if (this.#midnightResetTimer) {
            this.#adapter.clearTimeout(this.#midnightResetTimer);
            this.#midnightResetTimer = null;
        }
        // Cancel CS-LPC event stream
        if (this.#lpcStream) {
            this.#lpcStream.cancel();
            this.#lpcStream = null;
        }
        // Close CS-LPC client
        if (this.#csLpcClient && this.#csLpcClient.close) {
            this.#csLpcClient.close();
            this.#csLpcClient = null;
        }
        // Close EG-LPC clients on guards
        for (const guard of this.#guards) {
            if (guard instanceof EebusEnergyGuard && guard.egLpcClient) {
                guard.egLpcClient.close();
            }
        }
    }

    /**
     * Trigger FSM restart transition. Resets to init state.
     * Valid from: any state → init
     */
    restart() {
        this.#fsm.restart();
    }

    /**
     * Handle state changes for LPC Energy Guard states.
     * Called from HEMS coordinator when a state change matches an LPC guard.
     *
     * @param {string} localId - Local state ID (e.g., "LPC.EnergyGuards.Guard_WallBox.percentage")
     * @param {ioBroker.State} state - State object (only ack=false writes are forwarded here)
     */
    async handleGuardStateChange(localId, state) {
        const log = this.#adapter.log;
        log.debug(`LPC handleGuardStateChange: ${localId} = ${state.val}`);

        // localId is "LPC.EnergyGuards.Guard_Name.stateName"
        const parts = localId.split('.');
        // parts: ["LPC", "EnergyGuards", "Guard_Name", "stateName"]
        if (parts[0] !== 'LPC' || parts.length < 4) {
            return;
        }
        const guardFolder = parts[2]; // "Guard_Name"
        const stateName = parts[3]; // "percentage", "heartbeat", "connected", etc.

        // Extract the guard name from the folder name (strip "Guard_" prefix)
        if (!guardFolder.startsWith('Guard_')) {
            return;
        }
        const guardName = guardFolder.slice('Guard_'.length);

        // Find the matching guard
        const guard = this.#guards.find(g => g.name === guardName);
        if (!guard) {
            log.debug(`No LPC energy guard found for name "${guardName}" — ignoring state change`);
            return;
        }

        if (stateName === 'percentage') {
            // Percentage changed on ANY guard type: acknowledge and re-distribute if limit active
            log.info(`LPC energy guard "${guardName}" percentage changed to ${state.val}`);
            await this.#adapter.setStateAsync(`${guard.basePath}.percentage`, state.val, true);
            if (this.#lastLimitActive) {
                await this.#distributeLimit(true);
            }
        } else if (stateName === 'heartbeat') {
            // Heartbeat write: only applies to ManualEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPC manual energy guard "${guardName}" heartbeat write received`);
                await guard.onHeartbeatWrite();
                // Re-distribute if limit active (guard may now be connected)
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        } else if (stateName === 'connected') {
            // Connected write: only applies to ManualEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPC manual energy guard "${guardName}" connected changed to ${state.val}`);
                await guard.onConnectedWrite(state.val);
                // Connection state affects limit distribution for all guards
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        } else if (stateName === 'failsafeLimit') {
            // Failsafe limit write: applies to both ManualEnergyGuard and EebusEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPC manual energy guard "${guardName}" failsafeLimit changed to ${state.val}`);
                await guard.onFailsafeLimitWrite(state.val);
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            } else if (guard instanceof EebusEnergyGuard) {
                log.info(`LPC EEBUS energy guard "${guardName}" failsafeLimit changed to ${state.val}`);
                try {
                    await guard.onFailsafeLimitWrite(state.val);
                    if (this.#lastLimitActive) {
                        await this.#distributeLimit(true);
                    }
                } catch (err) {
                    log.warn(`Failed to write failsafe limit for LPC guard "${guardName}": ${err.message}`);
                }
            }
        } else if (stateName === 'manualLimit') {
            // Manual limit write: only applies to EebusEnergyGuard
            if (guard instanceof EebusEnergyGuard) {
                // Reject write while control box limit is active
                if (this.#controlBoxConnected && this.#lastLimitActive) {
                    log.warn(`Rejecting manual limit for LPC guard "${guardName}" — control box has an active limit`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    return;
                }

                const limitW = Number(state.val) || 0;
                log.info(`LPC EEBUS energy guard "${guardName}" manualLimit changed to ${limitW}`);

                // Cancel any existing manual limit timer for this guard
                const existingTimer = this.#manualLimitTimers.get(guardName);
                if (existingTimer) {
                    this.#adapter.clearTimeout(existingTimer);
                    this.#manualLimitTimers.delete(guardName);
                }

                try {
                    await guard.onManualLimitWrite(limitW);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, limitW, true);

                    if (limitW > 0) {
                        // Start 60-minute timer to auto-deactivate
                        const timer = this.#adapter.setTimeout(
                            async () => {
                                this.#manualLimitTimers.delete(guardName);
                                log.info(
                                    `Manual consumption limit duration expired for LPC guard "${guardName}" — deactivating`,
                                );
                                try {
                                    await guard.onManualLimitWrite(0);
                                } catch (err) {
                                    log.warn(
                                        `Failed to deactivate expired manual consumption limit for LPC guard "${guardName}": ${err.message}`,
                                    );
                                }
                                await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                            },
                            60 * 60 * 1000,
                        ); // 60 minutes

                        this.#manualLimitTimers.set(guardName, timer);
                    }
                } catch (err) {
                    log.warn(`Failed to write manual limit for LPC guard "${guardName}": ${err.message}`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                }
            }
        }
    }

    // ─── CS-LPC Event Subscription ─────────────────────────────────────

    /**
     * Subscribe to CS-LPC use case events via server streaming.
     * Handles all event types: DataUpdateLimit, LimitWriteApprovalRequired,
     * DataUpdateFailsafeConsumptionActivePowerLimit, DataUpdateFailsafeDurationMinimum,
     * DataUpdateHeartbeat.
     */
    #subscribeCsLpcEvents() {
        const log = this.#adapter.log;
        const cemAddr = [1];

        if (this.#lpcStream) {
            this.#lpcStream.cancel();
        }

        this.#lpcStream = subscribeCsLpcEvents(this.#controlClient, cemAddr, async evt => {
            log.debug(`CS-LPC event received: ${JSON.stringify(evt)}`);

            const eventName = evt.use_case_event && evt.use_case_event.event;

            if (eventName === 'UseCaseSupportUpdate') {
                log.debug('UseCaseSupportUpdate — no action needed');
            } else if (eventName === 'DataUpdateLimit') {
                await this.#handleDataUpdateLimit();
            } else if (eventName === 'LimitWriteApprovalRequired') {
                await this.#handleLimitWriteApprovalRequired();
            } else if (eventName === 'DataUpdateFailsafeConsumptionActivePowerLimit') {
                await this.#handleDataUpdateFailsafeLimit();
            } else if (eventName === 'DataUpdateFailsafeDurationMinimum') {
                await this.#handleDataUpdateFailsafeDuration();
            } else if (eventName === 'DataUpdateHeartbeat') {
                await this.#handleDataUpdateHeartbeat();
                // Track control box connection based on its specific SKI
                if (evt.remote_ski === this.#config.controlboxSki) {
                    await this.#setControlBoxConnected(true);
                }
            } else {
                log.warn(`Unknown CS-LPC event: ${eventName}`);
            }
        });
    }

    /**
     * Handle DataUpdateLimit: read current consumption limit and trigger FSM transitions.
     *
     * Transitions:
     *  - limit active → heartbeatActivatedLimit
     *  - limit deactivated → heartbeatDeactivatedLimit
     */
    async #handleDataUpdateLimit() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLpcClient, 'ConsumptionLimit', {});
        const limit = res.load_limit || {};
        log.info(`LPC consumption limit update: active=${limit.is_active}, value=${limit.value}`);

        // A limit write arrived — cancel the "no following limit" timer if running
        this.#clearFailsafeHeartbeatTimer();

        if (limit.is_active) {
            if (this.#fsm.can('heartbeatActivatedLimit')) {
                this.#fsm.heartbeatActivatedLimit();
                log.info(`LPC FSM transition: heartbeatActivatedLimit → ${this.state}`);
            }
            // Start duration timer if limit has a finite duration
            if (limit.duration_nanoseconds && Number(limit.duration_nanoseconds) > 0) {
                const durationMs = Number(limit.duration_nanoseconds) / 1_000_000;
                this.#startLimitDurationTimer(durationMs);
            }
        } else {
            if (this.#fsm.can('heartbeatDeactivatedLimit')) {
                this.#fsm.heartbeatDeactivatedLimit();
                log.info(`LPC FSM transition: heartbeatDeactivatedLimit → ${this.state}`);
            }
        }

        // Update limit state: show active limit value, 0 if deactivated
        const limitValue = limit.is_active ? limit.value || 0 : 0;
        this.#adapter.setState('LPC.limit', limitValue, true);

        // Update limitDuration: show duration in minutes, 0 if deactivated or indefinite
        const durationNs = limit.is_active ? Number(limit.duration_nanoseconds) || 0 : 0;
        const durationMin = durationNs > 0 ? Math.round(durationNs / 60_000_000_000) : 0;
        this.#adapter.setState('LPC.limitDuration', durationMin, true);

        // Distribute limit to all Energy Guards
        await this.#distributeLimit(!!limit.is_active);
    }

    /**
     * Handle LimitWriteApprovalRequired: approve or deny pending consumption limits.
     * Approve if limit >= sum of guard failsafe limits, deny otherwise.
     */
    async #handleLimitWriteApprovalRequired() {
        const log = this.#adapter.log;
        const contractualMax = Number(this.#config.contractualConsumptionNominalMax) || 0;
        const res = await callUnary(this.#csLpcClient, 'PendingConsumptionLimit', {});

        log.debug(`PendingConsumptionLimit raw response: ${JSON.stringify(res)}`);

        const pending = res.load_limits || {};

        if (typeof pending !== 'object' || Array.isArray(pending)) {
            log.warn(`PendingConsumptionLimit: unexpected load_limits type (${typeof pending}) — skipping`);
            return;
        }

        const entries = Object.entries(pending);

        /**
         * Decode a raw little-endian uint64 map key (8-byte binary string) to a JS number.
         * Falls back to Number() for plain numeric string keys.
         *
         * @param {string} key - The raw map key string
         * @returns {number} The decoded uint64 value as a JS number
         */
        function decodeMsgCounter(key) {
            if (/^\d+$/.test(key)) {
                return Number(key);
            }
            let result = 0;
            for (let i = Math.min(key.length, 8) - 1; i >= 0; i--) {
                result = result * 256 + key.charCodeAt(i);
            }
            return result;
        }

        // Calculate sum of all LPC energy guard failsafe limits
        const failsafeSum = this.#guards.reduce((sum, guard) => sum + (guard.failsafeLimit || 0), 0);

        for (const [msgCounter, loadLimit] of entries) {
            if (typeof loadLimit !== 'object' || loadLimit === null) {
                log.warn(`PendingConsumptionLimit: skipping malformed entry key="${msgCounter}"`);
                continue;
            }

            const msgCounterNum = decodeMsgCounter(msgCounter);
            if (!Number.isFinite(msgCounterNum)) {
                log.warn(`PendingConsumptionLimit: skipping entry with undecodable key="${msgCounter}"`);
                continue;
            }

            const value = loadLimit.value || 0;

            if (failsafeSum > value) {
                const reason = `Limit ${value}W is below sum of guard failsafe limits (${failsafeSum}W)`;
                log.warn(`LPC: Denying pending limit msgCounter=${msgCounter} — ${reason}`);

                await callUnary(this.#csLpcClient, 'ApproveOrDenyConsumptionLimit', {
                    msg_counter: msgCounterNum,
                    approve: false,
                    reason,
                });

                if (this.#fsm.can('heartbeatLimitNotApplicable')) {
                    this.#fsm.heartbeatLimitNotApplicable();
                    log.info(`LPC FSM transition: heartbeatLimitNotApplicable → ${this.state}`);
                }
                continue;
            }

            // Warn if limit is below the contractual maximum, but approve anyway
            if (value < contractualMax) {
                log.warn(
                    `LPC: Approving pending limit msgCounter=${msgCounterNum}, value=${value}W — ` +
                        `limit is below contractualConsumptionNominalMax (${contractualMax}W)`,
                );
            } else {
                log.info(
                    `LPC: Approving pending limit msgCounter=${msgCounterNum}, value=${value}W ` +
                        `(failsafe sum ${failsafeSum}W, contractual max ${contractualMax}W)`,
                );
            }

            await callUnary(this.#csLpcClient, 'ApproveOrDenyConsumptionLimit', {
                msg_counter: msgCounterNum,
                approve: true,
                reason: '',
            });
        }
    }

    /**
     * Handle DataUpdateFailsafeConsumptionActivePowerLimit: read current failsafe limit.
     */
    async #handleDataUpdateFailsafeLimit() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLpcClient, 'FailsafeConsumptionActivePowerLimit', {});
        log.info(`LPC failsafe consumption limit update: value=${res.limit}, changeable=${res.is_changeable}`);

        // Update LPC.limit if in failsafe state
        if (this.state === LPC_STATE.FAILSAFE) {
            this.#adapter.setState('LPC.limit', res.limit || 0, true);
        }
    }

    /**
     * Handle DataUpdateFailsafeDurationMinimum: read current failsafe duration.
     */
    async #handleDataUpdateFailsafeDuration() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLpcClient, 'FailsafeDurationMinimum', {});
        log.info(
            `LPC failsafe duration minimum update: ${res.duration_nanoseconds}ns, changeable=${res.is_changeable}`,
        );
    }

    /**
     * Handle DataUpdateHeartbeat: heartbeat event indicating CS may enter or leave failsafe.
     *
     * Transitions:
     *  - heartbeat NOT within duration → heartbeatTimeout
     *  - heartbeat received while in failsafe → starts 120s timer
     */
    async #handleDataUpdateHeartbeat() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLpcClient, 'IsHeartbeatWithinDuration', {});
        log.info(`LPC heartbeat update: withinDuration=${res.is_within_duration}`);

        if (!res.is_within_duration) {
            if (this.#fsm.can('heartbeatTimeout')) {
                this.#fsm.heartbeatTimeout();
                log.warn(`LPC FSM transition: heartbeatTimeout → ${this.state}`);
            }
        } else if (this.state === LPC_STATE.INIT) {
            // Heartbeat received in init — read limit state and transition accordingly
            await this.#handleDataUpdateLimit();
        } else if (this.state === LPC_STATE.FAILSAFE) {
            // Heartbeat received in failsafe — if no limit write within 120s → unlimitedAutonomous
            this.#startFailsafeHeartbeatTimer();
        }
    }

    // ─── EG-LPC Energy Guard Management ─────────────────────────────────

    /**
     * Initialize LPC Energy Guards from adapter configuration.
     * Creates guard instances, registers EG-LPC use cases for EEBUS guards,
     * and subscribes to EG-LPC events.
     */
    async #initEnergyGuards() {
        const config = this.#config;
        const log = this.#adapter.log;
        const guardConfigs = config.energyGuards || [];

        if (guardConfigs.length === 0) {
            // Still need to clean up any previously existing guard objects
            await this.#cleanupRemovedGuards(guardConfigs);
            return;
        }

        // Create top-level LPC.EnergyGuards folder (Requirement 12.1)
        await this.#adapter.extendObjectAsync('LPC.EnergyGuards', {
            type: 'folder',
            common: { name: 'LPC Energy Guards' },
            native: {},
        });

        const seenSkis = new Set();
        this.#guards = [];
        this.#egLpcEndpoints.clear();

        let eebusIndex = 0;

        for (const entry of guardConfigs) {
            if (entry.type === 'eebus') {
                // Check for duplicate SKI
                if (seenSkis.has(entry.ski)) {
                    log.error(`Duplicate SKI detected for LPC energy guard "${entry.name}" — skipping`);
                    continue;
                }
                seenSkis.add(entry.ski);

                const guard = new EebusEnergyGuard(
                    this.#adapter,
                    entry.name,
                    entry.ski,
                    config.heartbeatTimeoutSeconds,
                    this.#translate,
                    { pathPrefix: 'LPC' },
                );
                await guard.createObjects();
                this.#guards.push(guard);

                // Register EG-LPC use case for this EEBUS guard
                eebusIndex++;
                try {
                    const entityAddr = [1, eebusIndex];
                    await addEntity(this.#controlClient, 'EnergyManagementSystem', entityAddr);
                    const res = await callUnary(this.#controlClient, 'AddUseCase', {
                        entity_address: { entity_address: entityAddr },
                        use_case: { actor: 'EnergyGuard', name: 'limitationOfPowerConsumption' },
                    });
                    const endpoint = res.endpoint;
                    if (endpoint) {
                        this.#egLpcEndpoints.set(entry.ski, { endpoint, entityAddr });
                        log.info(
                            `EG-LPC UseCase added for guard "${entry.name}" at entity [1,${eebusIndex}], endpoint: ${endpoint}`,
                        );
                    } else {
                        log.error(`AddUseCase returned empty endpoint for LPC guard "${entry.name}" — skipping EG-LPC`);
                    }
                } catch (err) {
                    log.error(`Failed to add EG-LPC use case for guard "${entry.name}": ${err.message}`);
                }

                // Register the guard's SKI as trusted
                try {
                    await registerRemoteSki(this.#controlClient, entry.ski);
                    log.info(`Registered remote SKI for LPC guard "${entry.name}": ${entry.ski}`);
                } catch (err) {
                    log.error(`Failed to register remote SKI for LPC guard "${entry.name}": ${err.message}`);
                }
            } else if (entry.type === 'manual') {
                const guard = new ManualEnergyGuard(
                    this.#adapter,
                    entry.name,
                    config.heartbeatTimeoutSeconds,
                    this.#translate,
                    { pathPrefix: 'LPC' },
                );
                await guard.createObjects();
                this.#guards.push(guard);
            } else {
                log.warn(`Unknown LPC energy guard type "${entry.type}" for guard "${entry.name}" — skipping`);
            }
        }

        // Subscribe to EG-LPC use case events for pairing
        if (this.#egLpcEndpoints.size > 0) {
            this.#subscribeEgLpcEvents();
        }

        // Clean up objects for guards that were removed from config
        await this.#cleanupRemovedGuards(guardConfigs);

        log.info(`Initialized ${this.#guards.length} LPC energy guard(s)`);
    }

    /**
     * Remove ioBroker objects for energy guards that are no longer in the configuration.
     * Compares existing Guard_* channels under LPC.EnergyGuards with the current config
     * and recursively deletes any that are no longer defined.
     *
     * @param {object[]} guardConfigs - Current energy guard configuration entries
     */
    async #cleanupRemovedGuards(guardConfigs) {
        const log = this.#adapter.log;
        const adapterNamespace = this.#adapter.namespace;

        // Build set of expected guard channel IDs (without namespace prefix)
        const expectedNames = new Set(guardConfigs.map(entry => `LPC.EnergyGuards.Guard_${entry.name}`));

        try {
            // Get all objects under the LPC.EnergyGuards folder
            const objects = await this.#adapter.getAdapterObjectsAsync();
            const channelIds = Object.keys(objects).filter(id => {
                const localId = id.replace(`${adapterNamespace}.`, '');
                return localId.startsWith('LPC.EnergyGuards.Guard_') && objects[id].type === 'channel';
            });

            for (const fullId of channelIds) {
                const localId = fullId.replace(`${adapterNamespace}.`, '');
                if (!expectedNames.has(localId)) {
                    log.info(`Removing objects for deleted LPC energy guard: ${localId}`);
                    // Delete all child states first, then the channel itself
                    const children = Object.keys(objects).filter(id => id.startsWith(`${fullId}.`));
                    for (const childId of children) {
                        await this.#adapter.delObjectAsync(childId.replace(`${adapterNamespace}.`, ''));
                    }
                    await this.#adapter.delObjectAsync(localId);
                }
            }
        } catch (err) {
            log.warn(`Failed to clean up removed LPC energy guard objects: ${err.message}`);
        }
    }

    /**
     * Subscribe to SubscribeUseCaseEvents for EG-LPC use cases.
     * Handles pairing (UseCaseSupportUpdate), heartbeat, and failsafe limit events.
     * Creates the EG-LPC control client only once on UseCaseSupportUpdate.
     */
    #subscribeEgLpcEvents() {
        const log = this.#adapter.log;

        for (const [ski, { endpoint, entityAddr }] of this.#egLpcEndpoints) {
            const stream = this.#controlClient.SubscribeUseCaseEvents({
                entity_address: { entity_address: entityAddr },
                use_case: {
                    actor: 'EnergyGuard',
                    name: 'limitationOfPowerConsumption',
                },
            });

            stream.on('data', async evt => {
                const remoteSki = evt.remote_ski;
                const eventName = evt.use_case_event && evt.use_case_event.event;
                log.debug(
                    `EG-LPC event for entity [${entityAddr}]: remote_ski="${remoteSki || ''}", event=${eventName}`,
                );

                // Match incoming remote_ski to the guard with this SKI
                if (remoteSki !== ski) {
                    log.debug(
                        `EG-LPC event SKI mismatch for guard SKI=${ski}: got remote_ski="${remoteSki || ''}", event=${eventName}`,
                    );
                    return;
                }

                const guard = this.#guards.find(g => g instanceof EebusEnergyGuard && g.ski === ski);
                if (!guard) {
                    return;
                }

                if (eventName === 'UseCaseSupportUpdate') {
                    // Pairing event — create EG-LPC control client at the stored endpoint (only if not already created)
                    if (!guard.egLpcClient) {
                        const remoteEntityAddr = evt.remote_entity_address && evt.remote_entity_address.entity_address;
                        const egLpcClient = makeClient({
                            protoDir: PROTO_DIR,
                            protoRelPath: 'usecases/eg/lpc/service.proto',
                            pkg: 'eg_lpc',
                            service: 'EnergyGuardLPCControl',
                            endpoint,
                        });
                        guard.assignUseCaseClient(egLpcClient, remoteSki, remoteEntityAddr);
                        log.info(
                            `EG-LPC client assigned to guard "${guard.name}" (SKI=${ski}, remoteEntity=[${remoteEntityAddr}])`,
                        );
                    }
                } else if (eventName === 'DataUpdateHeartbeat') {
                    // Heartbeat event from the paired EG-LPC device
                    try {
                        await guard.handleHeartbeat();
                        log.debug(`LPC heartbeat received for guard "${guard.name}" (SKI=${ski})`);
                    } catch (err) {
                        log.warn(`Failed to handle LPC heartbeat for guard "${guard.name}": ${err.message}`);
                    }

                    // If a limit is currently active, re-run distribution
                    if (this.#lastLimitActive) {
                        try {
                            await this.#distributeLimit(true);
                        } catch (err) {
                            log.warn(`Failed to re-distribute LPC limit after heartbeat: ${err.message}`);
                        }
                    }
                } else if (eventName === 'DataUpdateFailsafeConsumptionActivePowerLimit') {
                    // Failsafe limit update from the remote device
                    try {
                        const failsafeValue = await guard.onRemoteFailsafeLimitUpdate();
                        log.info(`LPC failsafe limit updated for guard "${guard.name}": ${failsafeValue}W`);

                        // Re-distribute if limit is active (floor may have changed)
                        if (this.#lastLimitActive) {
                            await this.#distributeLimit(true);
                        }
                    } catch (err) {
                        log.warn(`Failed to read LPC failsafe limit for guard "${guard.name}": ${err.message}`);
                    }
                } else if (eventName === 'DataUpdateLimit') {
                    // Remote device confirmed the limit — read and update state
                    try {
                        await guard.onRemoteLimitUpdate();
                    } catch (err) {
                        log.warn(`Failed to handle DataUpdateLimit for LPC guard "${guard.name}": ${err.message}`);
                    }
                } else {
                    log.debug(`EG-LPC event "${eventName}" for guard "${guard.name}" — no action needed`);
                }
            });

            stream.on('error', err => {
                log.error(`EG-LPC event stream error for SKI=${ski}: ${err.message}`);
            });

            stream.on('end', () => {
                log.warn(`EG-LPC event stream ended for SKI=${ski}`);
            });
        }
    }

    // ─── Consumption Limit Distribution ─────────────────────────────────

    /**
     * Distribute a consumption limit to all LPC energy guards.
     * If inactive, deactivates all guards. Otherwise, reads percentages,
     * scales if >100%, and distributes proportionally.
     *
     * When a controlbox limit becomes active for the first time (transition from
     * inactive to active), any manual limits set on EEBUS guards are reset so the
     * controlbox limit takes precedence.
     *
     * @param {boolean} isActive - Whether the limit is active
     */
    async #distributeLimit(isActive) {
        const wasActive = this.#lastLimitActive;
        this.#lastLimitActive = isActive;

        if (!isActive) {
            for (const guard of this.#guards) {
                try {
                    await guard.deactivateLimit();
                } catch (err) {
                    this.#adapter.log.warn(`Failed to deactivate LPC limit on guard "${guard.name}": ${err.message}`);
                }
            }
            await this.#stopLimitTracking();
            return;
        }

        // Read the current controlbox limit value from the LPC state
        let controlboxLimit = 0;
        try {
            const limitState = await this.#adapter.getStateAsync('LPC.limit');
            if (limitState && limitState.val != null) {
                controlboxLimit = Number(limitState.val);
            }
        } catch {
            // Fall through with 0
        }
        if (controlboxLimit <= 0) {
            this.#adapter.log.warn('LPC controlbox limit is active but value is 0 — skipping distribution');
            return;
        }

        // Controlbox limit just became active — reset any manual limits on EEBUS guards
        if (!wasActive) {
            this.#startLimitTracking();
            for (const guard of this.#guards) {
                if (guard instanceof EebusEnergyGuard) {
                    try {
                        const manualState = await this.#adapter.getStateAsync(`${guard.basePath}.manualLimit`);
                        if (manualState && manualState.val) {
                            this.#adapter.log.info(
                                `LPC controlbox limit activated — resetting manual limit for guard "${guard.name}"`,
                            );
                            await guard.onManualLimitWrite(0);
                            await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                        }
                    } catch (err) {
                        this.#adapter.log.warn(
                            `Failed to reset manual limit for LPC guard "${guard.name}": ${err.message}`,
                        );
                    }
                }
            }
        }

        // Check if all guards are connected
        const allConnected = this.#guards.every(g => g.isConnected());

        if (!allConnected) {
            // Fallback: apply each guard's own failsafe limit (effectivePct=0 means floor applies)
            for (const guard of this.#guards) {
                try {
                    await guard.applyLimit(controlboxLimit, 0);
                } catch (err) {
                    this.#adapter.log.warn(
                        `Failed to apply fallback limit to LPC guard "${guard.name}": ${err.message}`,
                    );
                }
            }
            return;
        }

        // Read all percentages from ioBroker state objects
        const percentages = await Promise.all(this.#guards.map(g => g.getPercentage()));
        const sum = percentages.reduce((acc, p) => acc + p, 0);

        // If sum > 100%, scale proportionally
        const scale = sum > 100 ? 100 / sum : 1;

        if (scale < 1) {
            this.#adapter.log.info(
                `LPC percentage sum ${sum}% exceeds 100% — scaling down by factor ${scale.toFixed(4)}: ` +
                    `original=[${percentages.join(', ')}], ` +
                    `scaled=[${percentages.map(p => (p * scale).toFixed(2)).join(', ')}]`,
            );
        }

        for (let i = 0; i < this.#guards.length; i++) {
            const effectivePct = percentages[i] * scale;
            try {
                await this.#guards[i].applyLimit(controlboxLimit, effectivePct);
            } catch (err) {
                this.#adapter.log.warn(`Failed to apply limit to LPC guard "${this.#guards[i].name}": ${err.message}`);
            }
        }
    }

    /**
     * Update the control box connection state.
     * When the control box connects, reset any active manual limits on EEBUS guards.
     *
     * @param {boolean} connected - Whether the control box is connected
     */
    async #setControlBoxConnected(connected) {
        if (connected === this.#controlBoxConnected) {
            return;
        }
        this.#controlBoxConnected = connected;
        const log = this.#adapter.log;
        log.info(`LPC control box connection state: ${connected}`);

        if (connected) {
            // Reset manual limits on all EEBUS guards — control box takes over
            for (const guard of this.#guards) {
                if (guard instanceof EebusEnergyGuard) {
                    // Cancel the manual limit timer for this guard
                    const timer = this.#manualLimitTimers.get(guard.name);
                    if (timer) {
                        this.#adapter.clearTimeout(timer);
                        this.#manualLimitTimers.delete(guard.name);
                    }

                    try {
                        await guard.onManualLimitWrite(0);
                        await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    } catch (err) {
                        log.warn(`Failed to reset manual limit for LPC guard "${guard.name}": ${err.message}`);
                    }
                }
            }
        }
    }

    // ─── Limit Tracking ─────────────────────────────────────────────────

    /**
     * Start tracking limit-active time. Called when the controlbox limit becomes active.
     * Also schedules a per-minute accumulation tick and a midnight reset.
     */
    #startLimitTracking() {
        if (this.#limitActiveStartTime !== null) {
            return; // already tracking
        }
        this.#limitActiveStartTime = Date.now();

        // Accumulate every full minute while the limit is active
        this.#limitMinutesAccumTimer = this.#adapter.setInterval(async () => {
            this.#limitMinutesToday += 1;
            await this.#adapter.setStateAsync('LPC.limitMinutesToday', this.#limitMinutesToday, true);
        }, 60_000);

        this.#scheduleMidnightReset();
    }

    /**
     * Stop tracking limit-active time. Called when the controlbox limit becomes inactive.
     */
    async #stopLimitTracking() {
        if (this.#limitActiveStartTime === null) {
            return;
        }

        if (this.#limitMinutesAccumTimer) {
            this.#adapter.clearInterval(this.#limitMinutesAccumTimer);
            this.#limitMinutesAccumTimer = null;
        }

        // Reset start time — the interval already accumulated the minutes
        this.#limitActiveStartTime = null;

        // Keep midnight reset running so the accumulated total resets at midnight
    }

    /**
     * Schedule a timer that fires at the next midnight (local time) to reset the counter.
     * Reschedules itself so it fires every day at 00:00.
     */
    #scheduleMidnightReset() {
        if (this.#midnightResetTimer) {
            this.#adapter.clearTimeout(this.#midnightResetTimer);
        }

        const now = new Date();
        const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
        const msUntilMidnight = nextMidnight.getTime() - now.getTime();

        this.#midnightResetTimer = this.#adapter.setTimeout(async () => {
            this.#midnightResetTimer = null;
            this.#limitMinutesToday = 0;
            await this.#adapter.setStateAsync('LPC.limitMinutesToday', 0, true);
            this.#adapter.log.info('LPC midnight reset: LPC.limitMinutesToday reset to 0');
            // Reschedule for the next midnight
            this.#scheduleMidnightReset();
        }, msUntilMidnight);
    }

    // ─── FSM Lifecycle Methods ───────────────────────────────────────────

    /**
     * Called when the FSM enters a new state.
     * Starts timers for init and failsafe states.
     *
     * @param {object} lifecycle - { transition, from, to }
     */
    #onEnterState(lifecycle) {
        const log = this.#adapter.log;
        log.debug(`LPC FSM enter: ${lifecycle.from} → ${lifecycle.to} (${lifecycle.transition})`);

        this.#adapter.setState('LPC.state', lifecycle.to, true);

        if (lifecycle.to === LPC_STATE.INIT) {
            // Start 120s init timeout
            this.#startInitTimer();
            this.#setControlBoxConnected(false);
            this.#adapter.setState('LPC.limit', 0, true);
            this.#adapter.setState('LPC.limitDuration', 0, true);
        } else if (lifecycle.to === LPC_STATE.UNLIMITED_AUTONOMOUS) {
            // Init timeout or failsafe expired — control box is gone
            this.#setControlBoxConnected(false);
            this.#adapter.setState('LPC.limit', 0, true);
            this.#adapter.setState('LPC.limitDuration', 0, true);
        } else if (lifecycle.to === LPC_STATE.FAILSAFE) {
            // After failsafe duration minimum expires → unlimitedAutonomous
            this.#startFailsafeTimer();
            this.#setControlBoxConnected(false);
            // Write failsafe limit to LPC.limit
            this.#updateFailsafeLimitState();
        }
    }

    /**
     * Called when the FSM leaves a state.
     * Clears timers that are no longer relevant.
     *
     * @param {object} lifecycle - { transition, from, to }
     */
    #onLeaveState(lifecycle) {
        if (lifecycle.from === LPC_STATE.INIT) {
            this.#clearInitTimer();
        } else if (lifecycle.from === LPC_STATE.FAILSAFE) {
            this.#clearFailsafeTimer();
            this.#clearFailsafeHeartbeatTimer();
        } else if (lifecycle.from === LPC_STATE.LIMITED) {
            this.#clearLimitDurationTimer();
        }
    }

    /**
     * Read the failsafe limit and write it to LPC.limit.
     * Called when entering failsafe state.
     */
    async #updateFailsafeLimitState() {
        try {
            const res = await callUnary(this.#csLpcClient, 'FailsafeConsumptionActivePowerLimit', {});
            this.#adapter.setState('LPC.limit', res.limit || 0, true);
        } catch (err) {
            this.#adapter.log.warn(`Failed to read failsafe limit for LPC.limit: ${err.message}`);
        }
    }

    // ─── Timer Management ────────────────────────────────────────────────

    /**
     * Start the init timeout timer (120s).
     * init → unlimitedAutonomous if no heartbeat with limit received.
     */
    #startInitTimer() {
        this.#clearInitTimer();
        const log = this.#adapter.log;
        this.#initTimer = this.#adapter.setTimeout(() => {
            if (this.#fsm.can('initTimeout')) {
                log.warn('LPC init timeout (120s) — no heartbeat/limit received, entering unlimitedAutonomous');
                this.#fsm.initTimeout();
            }
        }, 120_000);
    }

    /**
     * Clear the init timeout timer.
     */
    #clearInitTimer() {
        if (this.#initTimer) {
            this.#adapter.clearTimeout(this.#initTimer);
            this.#initTimer = null;
        }
    }

    /**
     * Start the failsafe duration timer.
     * failsafe → unlimitedAutonomous after failsafe duration minimum expires.
     * Reads the configured failsafe duration from the CS LPC service.
     */
    async #startFailsafeTimer() {
        this.#clearFailsafeTimer();
        const log = this.#adapter.log;

        let durationMs = 2 * 3600 * 1000; // default 2h
        try {
            const res = await callUnary(this.#csLpcClient, 'FailsafeDurationMinimum', {});
            if (res.duration_nanoseconds > 0) {
                durationMs = Number(res.duration_nanoseconds) / 1_000_000;
            }
        } catch (err) {
            log.warn(`Failed to read FailsafeDurationMinimum, using default 2h: ${err.message}`);
        }

        log.info(`LPC failsafe timer started: ${durationMs}ms`);
        this.#failsafeTimer = this.#adapter.setTimeout(() => {
            if (this.#fsm.can('failsafeDurationExpired')) {
                log.warn('LPC failsafe duration expired — entering unlimitedAutonomous');
                this.#fsm.failsafeDurationExpired();
            }
        }, durationMs);
    }

    /**
     * Clear the failsafe duration timer.
     */
    #clearFailsafeTimer() {
        if (this.#failsafeTimer) {
            this.#adapter.clearTimeout(this.#failsafeTimer);
            this.#failsafeTimer = null;
        }
    }

    /**
     * Start a 120s timer after receiving heartbeat in failsafe.
     * If no following limit write arrives within 120s → unlimitedAutonomous.
     */
    #startFailsafeHeartbeatTimer() {
        this.#clearFailsafeHeartbeatTimer();
        const log = this.#adapter.log;
        this.#failsafeHeartbeatTimer = this.#adapter.setTimeout(() => {
            if (this.#fsm.can('heartbeatNoFollowingLimit')) {
                log.warn(
                    'LPC: No limit received within 120s after heartbeat in failsafe — entering unlimitedAutonomous',
                );
                this.#fsm.heartbeatNoFollowingLimit();
            }
        }, 120_000);
    }

    /**
     * Clear the failsafe heartbeat timer (cancelled when a limit write is received).
     */
    #clearFailsafeHeartbeatTimer() {
        if (this.#failsafeHeartbeatTimer) {
            this.#adapter.clearTimeout(this.#failsafeHeartbeatTimer);
            this.#failsafeHeartbeatTimer = null;
        }
    }

    /**
     * Start the limit duration timer.
     * limited → unlimitedControlled when the activated limit's duration expires.
     *
     * @param {number} durationMs - Duration in milliseconds
     */
    #startLimitDurationTimer(durationMs) {
        this.#clearLimitDurationTimer();
        if (!durationMs || durationMs <= 0) {
            return; // no duration set — limit is indefinite until explicitly deactivated
        }
        const log = this.#adapter.log;
        log.info(`LPC limit duration timer started: ${durationMs}ms`);
        this.#limitDurationTimer = this.#adapter.setTimeout(() => {
            if (this.#fsm.can('limitDurationExpired')) {
                log.info('LPC limit duration expired — entering unlimitedControlled');
                this.#fsm.limitDurationExpired();
            }
        }, durationMs);
    }

    /**
     * Clear the limit duration timer.
     */
    #clearLimitDurationTimer() {
        if (this.#limitDurationTimer) {
            this.#adapter.clearTimeout(this.#limitDurationTimer);
            this.#limitDurationTimer = null;
        }
    }

    // ─── FSM Transition Helpers ──────────────────────────────────────────

    /**
     * Check whether a transition is possible from the current state.
     *
     * @param {string} transition - Transition name
     * @returns {boolean} true if the transition can fire
     */
    can(transition) {
        return this.#fsm.can(transition);
    }

    /**
     * Trigger a named FSM transition if it is valid from the current state.
     *
     * @param {string} transition - Transition name
     * @returns {boolean} true if the transition fired, false if not possible
     */
    trigger(transition) {
        if (this.#fsm.can(transition)) {
            this.#fsm[transition]();
            return true;
        }
        return false;
    }
}

/**
 * Determine whether a pending consumption limit should be approved or denied.
 *
 * Approval rule:
 * Approve if pendingLimit >= sum of all guard failsafe limits; deny otherwise.
 *
 * @param {number} pendingLimit - The pending consumption limit value in watts
 * @param {number[]} guardFailsafeLimits - Array of failsafe limit values (watts) for each configured guard
 * @returns {boolean} true if the limit should be approved, false if denied
 */
function shouldApproveLimit(pendingLimit, guardFailsafeLimits) {
    const failsafeSum = guardFailsafeLimits.reduce((sum, limit) => sum + limit, 0);
    return pendingLimit >= failsafeSum;
}

/**
 * Pure function to distribute a consumption limit across energy guards.
 *
 * Algorithm:
 * 1. Separate guards into connected and disconnected
 * 2. Skip disconnected guards from proportional distribution
 * 3. Scale connected percentages if their sum exceeds 100%
 * 4. Redistribute disconnected guards' shares proportionally among connected guards
 * 5. Calculate effective limit as max(effectivePct * totalLimit / 100, failsafeLimit)
 *
 * @param {number} totalLimit - The total consumption limit to distribute (watts)
 * @param {Array<{pct: number, connected: boolean, failsafeLimit: number}>} guards - Guard data
 * @returns {Array<{effectivePct: number, effectiveLimit: number, skip: boolean}>} Distribution result per guard
 */
function distributeConsumptionLimit(totalLimit, guards) {
    if (guards.length === 0) {
        return [];
    }

    const results = guards.map(() => ({ effectivePct: 0, effectiveLimit: 0, skip: false }));

    // Separate connected vs disconnected
    const connectedIndices = [];
    const disconnectedIndices = [];

    for (let i = 0; i < guards.length; i++) {
        if (guards[i].connected) {
            connectedIndices.push(i);
        } else {
            disconnectedIndices.push(i);
            results[i].skip = true;
            // Disconnected guards get their failsafe limit as effective limit
            results[i].effectiveLimit = guards[i].failsafeLimit;
        }
    }

    // If no guards are connected, all get failsafe limit (skip=true)
    if (connectedIndices.length === 0) {
        return results;
    }

    // Gather connected guard percentages
    const connectedPcts = connectedIndices.map(i => guards[i].pct);
    const connectedSum = connectedPcts.reduce((acc, p) => acc + p, 0);

    // Scale percentages if sum > 100%
    const scale = connectedSum > 100 ? 100 / connectedSum : 1;
    const scaledPcts = connectedPcts.map(p => p * scale);

    // The total "bucket" for connected guards includes any disconnected shares
    // that should be redistributed.
    // Disconnected guards' shares are redistributed proportionally among connected guards.
    const disconnectedPctSum = disconnectedIndices.reduce((acc, i) => acc + guards[i].pct, 0);
    const scaledConnectedSum = scaledPcts.reduce((acc, p) => acc + p, 0);

    // Redistribute disconnected shares proportionally among connected guards
    let effectivePcts;
    if (scaledConnectedSum > 0 && disconnectedPctSum > 0) {
        // Each connected guard gets its share + proportional portion of disconnected shares
        const disconnectedScaled = disconnectedPctSum * scale;
        effectivePcts = scaledPcts.map(p => p + (p / scaledConnectedSum) * disconnectedScaled);
    } else {
        effectivePcts = scaledPcts;
    }

    // Calculate effective limits for each connected guard
    for (let j = 0; j < connectedIndices.length; j++) {
        const i = connectedIndices[j];
        const effectivePct = effectivePcts[j];
        const calculatedLimit = (effectivePct * totalLimit) / 100;
        const effectiveLimit = Math.max(calculatedLimit, guards[i].failsafeLimit);

        results[i].effectivePct = effectivePct;
        results[i].effectiveLimit = effectiveLimit;
    }

    return results;
}

module.exports = { LpcUseCase, LPC_STATE, LPC_TRANSITIONS, shouldApproveLimit, distributeConsumptionLimit };
