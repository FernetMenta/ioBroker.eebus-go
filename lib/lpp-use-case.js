'use strict';

const path = require('node:path');
const StateMachine = require('javascript-state-machine');
const { makeClient, callUnary } = require('./grpc-cslpc');
const { EebusEnergyGuard, ManualEnergyGuard } = require('./energy-guard');
const { registerRemoteSki } = require('./grpc-service');

/**
 * Root directory for protobuf definitions.
 */
const PROTO_DIR = path.join(__dirname, 'protobuf');

/**
 * LPP states as defined in EEBus UC TS - Limitation of Power Production §2.3.2
 */
const LPP_STATE = Object.freeze({
    INIT: 'init',
    UNLIMITED_CONTROLLED: 'unlimitedControlled',
    LIMITED: 'limited',
    FAILSAFE: 'failsafe',
    UNLIMITED_AUTONOMOUS: 'unlimitedAutonomous',
});

/**
 * FSM transition table for the LPP use case.
 * Each entry maps { name, from, to } per EEBus UC TS §2.3.3.
 */
const LPP_TRANSITIONS = Object.freeze([
    // T1: init → unlimitedControlled
    { name: 'heartbeatDeactivatedLimit', from: LPP_STATE.INIT, to: LPP_STATE.UNLIMITED_CONTROLLED },
    { name: 'heartbeatLimitNotApplicable', from: LPP_STATE.INIT, to: LPP_STATE.UNLIMITED_CONTROLLED },

    // T2: init → limited
    { name: 'heartbeatActivatedLimit', from: LPP_STATE.INIT, to: LPP_STATE.LIMITED },

    // T3: init → unlimitedAutonomous
    { name: 'initTimeout', from: LPP_STATE.INIT, to: LPP_STATE.UNLIMITED_AUTONOMOUS },

    // T4: unlimitedControlled → limited
    { name: 'heartbeatActivatedLimit', from: LPP_STATE.UNLIMITED_CONTROLLED, to: LPP_STATE.LIMITED },

    // T5: unlimitedControlled → failsafe
    { name: 'heartbeatTimeout', from: LPP_STATE.UNLIMITED_CONTROLLED, to: LPP_STATE.FAILSAFE },

    // T6: limited → unlimitedControlled
    { name: 'limitDurationExpired', from: LPP_STATE.LIMITED, to: LPP_STATE.UNLIMITED_CONTROLLED },
    { name: 'heartbeatDeactivatedLimit', from: LPP_STATE.LIMITED, to: LPP_STATE.UNLIMITED_CONTROLLED },
    { name: 'heartbeatLimitNotApplicable', from: LPP_STATE.LIMITED, to: LPP_STATE.UNLIMITED_CONTROLLED },

    // T7: limited → failsafe
    { name: 'heartbeatTimeout', from: LPP_STATE.LIMITED, to: LPP_STATE.FAILSAFE },

    // T8: failsafe → unlimitedControlled
    { name: 'heartbeatDeactivatedLimit', from: LPP_STATE.FAILSAFE, to: LPP_STATE.UNLIMITED_CONTROLLED },
    { name: 'heartbeatLimitNotApplicable', from: LPP_STATE.FAILSAFE, to: LPP_STATE.UNLIMITED_CONTROLLED },

    // T9: failsafe → limited
    { name: 'heartbeatActivatedLimit', from: LPP_STATE.FAILSAFE, to: LPP_STATE.LIMITED },

    // T10: failsafe → unlimitedAutonomous
    { name: 'failsafeDurationExpired', from: LPP_STATE.FAILSAFE, to: LPP_STATE.UNLIMITED_AUTONOMOUS },
    { name: 'heartbeatNoFollowingLimit', from: LPP_STATE.FAILSAFE, to: LPP_STATE.UNLIMITED_AUTONOMOUS },

    // T11: unlimitedAutonomous → unlimitedControlled
    { name: 'heartbeatDeactivatedLimit', from: LPP_STATE.UNLIMITED_AUTONOMOUS, to: LPP_STATE.UNLIMITED_CONTROLLED },
    {
        name: 'heartbeatLimitNotApplicable',
        from: LPP_STATE.UNLIMITED_AUTONOMOUS,
        to: LPP_STATE.UNLIMITED_CONTROLLED,
    },

    // T12: unlimitedAutonomous → limited
    { name: 'heartbeatActivatedLimit', from: LPP_STATE.UNLIMITED_AUTONOMOUS, to: LPP_STATE.LIMITED },

    // T0: any → init (restart)
    { name: 'restart', from: '*', to: LPP_STATE.INIT },
]);

/**
 * LPP Use Case class encapsulating the Limitation of Power Production finite state machine.
 *
 * States (§2.3.2):
 *  - init: CS starts here after (re)start, limited by failsafe power limit
 *  - unlimitedControlled: CS not limited, but controlled by Energy Guard
 *  - limited: CS in limited state, controlled by Energy Guard
 *  - failsafe: CS not controlled by Energy Guard, limited by failsafe limit
 *  - unlimitedAutonomous: CS not limited, produces as if no external limitation exists
 *
 * This class manages:
 *  - FSM transitions
 *  - Timer management (init timeout, failsafe duration, failsafe heartbeat, limit duration)
 *  - Timer cancellation on state exit (Requirement 3.7)
 *
 * Sign convention: EEBUS uses negative values for production power. This class converts
 * at the gRPC boundary (Math.abs on read, negate on write) so all internal values and
 * ioBroker objects use positive watts.
 */
class LppUseCase {
    #adapter;
    #config;
    #controlClient;
    #translate;
    #csLppClient;
    #fsm;
    #initTimer;
    #failsafeTimer;
    #failsafeHeartbeatTimer;
    #limitDurationTimer;
    #eventStream;
    #failsafeLimit; // eslint-disable-line no-unused-private-class-members -- updated by event handler, read for approval logic
    #failsafeDuration; // eslint-disable-line no-unused-private-class-members -- updated by event handler, used for failsafe timer
    #lastHeartbeatCounter; // eslint-disable-line no-unused-private-class-members -- updated by event handler, used for counter validation
    #guards;
    #egLppEndpoints;
    #egLppStreams;
    #lastLimitActive;
    #controlBoxConnected;
    #manualLimitTimers;
    #limitMinutesToday;
    #limitActiveStartTime;
    #limitMinutesAccumTimer;
    #midnightResetTimer;
    #lpcEntityMap;

    /**
     * Create a new LppUseCase instance.
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
        this.#csLppClient = null;
        this.#initTimer = null;
        this.#failsafeTimer = null;
        this.#failsafeHeartbeatTimer = null;
        this.#limitDurationTimer = null;
        this.#eventStream = null;
        this.#failsafeLimit = 4200;
        this.#failsafeDuration = 2 * 3600 * 1000000000; // 2h in nanoseconds
        this.#lastHeartbeatCounter = null;
        this.#guards = [];
        this.#egLppEndpoints = new Map();
        this.#egLppStreams = [];
        this.#lastLimitActive = false;
        this.#controlBoxConnected = false;
        this.#manualLimitTimers = new Map();
        this.#limitMinutesToday = 0;
        this.#limitActiveStartTime = null;
        this.#limitMinutesAccumTimer = null;
        this.#midnightResetTimer = null;
        this.#lpcEntityMap = new Map();

        this.#fsm = new StateMachine({
            init: LPP_STATE.INIT,
            transitions: LPP_TRANSITIONS,
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
     * Current state of the LPP FSM.
     *
     * @returns {string} One of the LPP_STATE constants
     */
    get state() {
        return this.#fsm.state;
    }

    /**
     * Start the LPP use case.
     * Registers CS-LPP use case, creates clients, subscribes to events, and initializes guards.
     */
    async start() {
        const log = this.#adapter.log;
        log.info('LPP use case starting');

        // Requirement 9.1: Create "LPP" folder at adapter namespace root
        await this.#adapter.extendObjectAsync('LPP', {
            type: 'folder',
            common: { name: 'LPP' },
            native: {},
        });

        // Requirement 9.2: Create LPP state objects with initial defaults
        const t = this.#translate;
        await this.#adapter.extendObjectAsync('LPP.state', {
            type: 'state',
            common: {
                name: t('State'),
                type: 'string',
                role: 'text',
                def: 'init',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.#adapter.extendObjectAsync('LPP.limit', {
            type: 'state',
            common: {
                name: t('Limit'),
                type: 'number',
                role: 'value.power',
                unit: 'W',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });
        await this.#adapter.extendObjectAsync('LPP.limitDuration', {
            type: 'state',
            common: {
                name: t('Limit Duration'),
                type: 'number',
                role: 'value',
                unit: 'min',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });
        await this.#adapter.extendObjectAsync('LPP.limitMinutesToday', {
            type: 'state',
            common: {
                name: t('Limit Minutes Today'),
                type: 'number',
                role: 'value',
                unit: 'min',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });

        // Register CS-LPP use case at entity address [1]
        let csLppEndpoint;
        try {
            const res = await callUnary(this.#controlClient, 'AddUseCase', {
                entity_address: { entity_address: [1] },
                use_case: { actor: 'ControllableSystem', name: 'limitationOfPowerProduction' },
            });
            csLppEndpoint = res.endpoint;
        } catch (err) {
            log.error(`Failed to register CS-LPP use case: ${err.message}`);
            this.#startInitTimer();
            return;
        }

        // Handle empty endpoint: treat as failed registration
        if (!csLppEndpoint) {
            log.error('CS-LPP use case registration returned empty endpoint — skipping LPP client creation');
            this.#startInitTimer();
            return;
        }

        log.info(`CS-LPP UseCase added with endpoint: ${csLppEndpoint}`);

        // Create CS-LPP gRPC client at the returned endpoint
        this.#csLppClient = makeClient({
            protoDir: PROTO_DIR,
            protoRelPath: 'usecases/cs/lpp/service.proto',
            pkg: 'cs_lpp',
            service: 'ControllableSystemLPPControl',
            endpoint: csLppEndpoint,
        });

        // Configure initial parameters
        // Configure initial parameters (negate values for EEBUS production sign convention)
        const nominalMax = this.#config.contractualProductionNominalMax || 4200;
        await callUnary(this.#csLppClient, 'SetProductionNominalMax', { value: -nominalMax });
        await callUnary(this.#csLppClient, 'SetProductionLimit', {
            load_limit: {
                is_changeable: true,
                is_active: false,
                value: -4200,
            },
        });
        await callUnary(this.#csLppClient, 'SetFailsafeProductionActivePowerLimit', {
            value: -4200,
            is_changeable: false,
        });
        await callUnary(this.#csLppClient, 'SetFailsafeDurationMinimum', {
            is_changeable: false,
            duration_nanoseconds: 2 * 3600 * 1000000000, // 2h in ns
        });

        log.info('CS-LPP client configured with initial parameters');

        // Subscribe to CS-LPP events
        this.#subscribeCsLppEvents();

        this.#startInitTimer();
    }

    /**
     * Start the energy guard initialization phase (called after startService).
     * Registers EG-LPP use cases on pre-created entities, subscribes to EG events.
     *
     * @param {Map<string, number[]>} egEntityMap - Map of SKI → entity address (created by Hems)
     */
    async startEnergyGuards(egEntityMap) {
        this.#lpcEntityMap = egEntityMap || new Map();
        await this.#initEnergyGuards();
    }

    /**
     * Stop the LPP use case, cleaning up all resources.
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
        // Cancel CS-LPP event stream
        if (this.#eventStream) {
            this.#eventStream.cancel();
            this.#eventStream = null;
        }
        // Close CS-LPP client
        if (this.#csLppClient) {
            this.#csLppClient.close();
            this.#csLppClient = null;
        }
        // Cancel EG-LPP event streams
        for (const stream of this.#egLppStreams) {
            stream.cancel();
        }
        this.#egLppStreams = [];
        // Close EG-LPP clients on guards
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
     * Handle state changes for LPP Energy Guard states.
     * Called from HEMS coordinator when a state change matches an LPP guard.
     *
     * @param {string} localId - Local state ID (e.g., "LPP.EnergyGuards.Guard_PV.percentage")
     * @param {ioBroker.State} state - State object (only ack=false writes are forwarded here)
     */
    async handleGuardStateChange(localId, state) {
        const log = this.#adapter.log;
        log.debug(`LPP handleGuardStateChange: ${localId} = ${state.val}`);

        // localId is "LPP.EnergyGuards.Guard_Name.stateName"
        const parts = localId.split('.');
        // parts: ["LPP", "EnergyGuards", "Guard_Name", "stateName"]
        if (parts.length < 4) {
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
            log.debug(`No LPP energy guard found for name "${guardName}" — ignoring state change`);
            return;
        }

        if (stateName === 'percentage') {
            // Percentage changed on ANY guard type: acknowledge and re-distribute if limit active
            log.info(`LPP energy guard "${guardName}" percentage changed to ${state.val}`);
            await this.#adapter.setStateAsync(`${guard.basePath}.percentage`, state.val, true);
            if (this.#lastLimitActive) {
                await this.#distributeLimit(true);
            }
        } else if (stateName === 'heartbeat') {
            // Heartbeat write: only applies to ManualEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPP manual energy guard "${guardName}" heartbeat write received`);
                await guard.onHeartbeatWrite();
                // Re-distribute if limit active (guard may now be connected)
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        } else if (stateName === 'connected') {
            // Connected write: only applies to ManualEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPP manual energy guard "${guardName}" connected changed to ${state.val}`);
                await guard.onConnectedWrite(state.val);
                // Connection state affects limit distribution for all guards
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        } else if (stateName === 'failsafeLimit') {
            // Failsafe limit write: applies to both ManualEnergyGuard and EebusEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPP manual energy guard "${guardName}" failsafeLimit changed to ${state.val}`);
                await guard.onFailsafeLimitWrite(state.val);
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            } else if (guard instanceof EebusEnergyGuard) {
                log.info(`LPP EEBUS energy guard "${guardName}" failsafeLimit changed to ${state.val}`);
                try {
                    await guard.onFailsafeLimitWrite(state.val);
                    if (this.#lastLimitActive) {
                        await this.#distributeLimit(true);
                    }
                } catch (err) {
                    log.warn(`Failed to write failsafe limit for LPP guard "${guardName}": ${err.message}`);
                }
            }
        } else if (stateName === 'manualLimit') {
            // Manual limit write: only applies to EebusEnergyGuard
            if (guard instanceof EebusEnergyGuard) {
                // Requirement 14.5: Reject write while control box limit is active
                if (this.#controlBoxConnected && this.#lastLimitActive) {
                    log.warn(`Rejecting manual limit for LPP guard "${guardName}" — control box has an active limit`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    return;
                }

                const limitW = Number(state.val) || 0;
                log.info(`LPP EEBUS energy guard "${guardName}" manualLimit changed to ${limitW}`);

                // Cancel any existing manual limit timer for this guard
                const existingTimer = this.#manualLimitTimers.get(guardName);
                if (existingTimer) {
                    this.#adapter.clearTimeout(existingTimer);
                    this.#manualLimitTimers.delete(guardName);
                }

                const egLppClient = guard.egLpcClient;
                if (!egLppClient || !guard.isConnected()) {
                    log.warn(`Cannot write manual production limit for LPP guard "${guardName}" — not connected`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    return;
                }

                try {
                    if (limitW > 0) {
                        // Requirement 14.1: Send WriteProductionLimit with 60-minute duration
                        const durationNs = 60 * 60 * 1_000_000_000; // 60 minutes in nanoseconds
                        await callUnary(egLppClient, 'WriteProductionLimit', {
                            remote_ski: guard.ski,
                            remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                            limit: {
                                is_active: true,
                                value: -limitW,
                                duration_nanoseconds: durationNs,
                            },
                        });
                        log.info(
                            `Manual production limit ${limitW}W sent to LPP guard "${guardName}" (duration: 60min)`,
                        );
                        await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, limitW, true);

                        // Requirement 14.4: Start 60-minute timer to auto-deactivate
                        const timer = this.#adapter.setTimeout(
                            async () => {
                                this.#manualLimitTimers.delete(guardName);
                                log.info(
                                    `Manual production limit duration expired for LPP guard "${guardName}" — deactivating`,
                                );
                                try {
                                    const client = guard.egLpcClient;
                                    if (client && guard.isConnected()) {
                                        await callUnary(client, 'WriteProductionLimit', {
                                            remote_ski: guard.ski,
                                            remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                                            limit: { is_active: false, value: 0 },
                                        });
                                    }
                                } catch (err) {
                                    log.warn(
                                        `Failed to deactivate expired manual production limit for LPP guard "${guardName}": ${err.message}`,
                                    );
                                }
                                await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                            },
                            60 * 60 * 1000,
                        ); // 60 minutes

                        this.#manualLimitTimers.set(guardName, timer);
                    } else {
                        // Requirement 14.2: Deactivate manual limit
                        await callUnary(egLppClient, 'WriteProductionLimit', {
                            remote_ski: guard.ski,
                            remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                            limit: { is_active: false, value: 0 },
                        });
                        log.info(`Manual production limit deactivated for LPP guard "${guardName}"`);
                        await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    }
                } catch (err) {
                    // Requirement 14.6: gRPC failure — log warning, reset to 0
                    log.warn(`Failed to write manual production limit for LPP guard "${guardName}": ${err.message}`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                }
            }
        }
    }

    // ─── CS-LPP Event Subscription ─────────────────────────────────────

    /**
     * Subscribe to CS-LPP use case events via server streaming.
     * Handles all event types: DataUpdateLimit, LimitWriteApprovalRequired,
     * DataUpdateFailsafeProductionActivePowerLimit, DataUpdateFailsafeDurationMinimum,
     * DataUpdateHeartbeat.
     *
     * Requirement 2.1: Subscribe to events for actor "ControllableSystem",
     * use case "limitationOfPowerProduction".
     */
    #subscribeCsLppEvents() {
        const log = this.#adapter.log;

        if (this.#eventStream) {
            this.#eventStream.cancel();
        }

        this.#eventStream = this.#controlClient.SubscribeUseCaseEvents({
            entity_address: { entity_address: [1] },
            use_case: {
                actor: 'ControllableSystem',
                name: 'limitationOfPowerProduction',
            },
        });

        this.#eventStream.on('data', async evt => {
            try {
                log.debug(`CS-LPP event received: ${JSON.stringify(evt)}`);

                const eventName = evt.use_case_event && evt.use_case_event.event;

                if (eventName === 'UseCaseSupportUpdate') {
                    log.debug('CS-LPP UseCaseSupportUpdate — no action needed');
                } else if (eventName === 'DataUpdateLimit') {
                    await this.#handleDataUpdateLimit();
                } else if (eventName === 'LimitWriteApprovalRequired') {
                    await this.#handleLimitWriteApprovalRequired();
                } else if (eventName === 'DataUpdateFailsafeProductionActivePowerLimit') {
                    await this.#handleDataUpdateFailsafeLimit();
                } else if (eventName === 'DataUpdateFailsafeDurationMinimum') {
                    await this.#handleDataUpdateFailsafeDuration();
                } else if (eventName === 'DataUpdateHeartbeat') {
                    await this.#handleDataUpdateHeartbeat();
                } else {
                    log.warn(`Unknown CS-LPP event: ${eventName}`);
                }
            } catch (err) {
                log.error(`CS-LPP event handler error: ${err.message}\n${err.stack}`);
            }
        });

        this.#eventStream.on('error', err => {
            log.warn(`CS-LPP event stream error: ${err.message}`);
            // Requirement 2.7: stream termination triggers heartbeatTimeout
            if (this.#fsm.can('heartbeatTimeout')) {
                log.warn('CS-LPP stream terminated — triggering heartbeatTimeout');
                this.#fsm.heartbeatTimeout();
            }
        });

        this.#eventStream.on('end', () => {
            log.warn('CS-LPP event stream ended');
            // Requirement 2.7: stream termination triggers heartbeatTimeout
            if (this.#fsm.can('heartbeatTimeout')) {
                log.warn('CS-LPP stream ended — triggering heartbeatTimeout');
                this.#fsm.heartbeatTimeout();
            }
        });
    }

    /**
     * Handle DataUpdateLimit: read current production limit and trigger FSM transitions.
     * Requirement 2.2: trigger heartbeatActivatedLimit (active), heartbeatDeactivatedLimit (inactive),
     * or heartbeatLimitNotApplicable.
     * Requirement 9.4: update LPP.limit and LPP.limitDuration on active limit.
     * Requirement 9.5: set LPP.limit=0 and LPP.limitDuration=0 on deactivation.
     */
    async #handleDataUpdateLimit() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLppClient, 'ProductionLimit', {});
        const limit = res.load_limit || {};
        log.info(`LPP production limit update: active=${limit.is_active}, value=${limit.value}`);

        // A limit write arrived — cancel the "no following limit" timer if running
        this.#clearFailsafeHeartbeatTimer();

        if (limit.is_active) {
            if (this.#fsm.can('heartbeatActivatedLimit')) {
                this.#fsm.heartbeatActivatedLimit();
                log.info(`LPP FSM transition: heartbeatActivatedLimit → ${this.state}`);
            }

            // Requirement 9.4: Update LPP.limit with value in watts
            const limitValue = Math.abs(limit.value || 0);
            this.#adapter.setState('LPP.limit', limitValue, true);

            // Requirement 9.4: Update LPP.limitDuration with duration in minutes
            const durationNs = Number(limit.duration_nanoseconds) || 0;
            const durationMin = durationNs > 0 ? Math.round(durationNs / 60_000_000_000) : 0;
            this.#adapter.setState('LPP.limitDuration', durationMin, true);

            // Start duration timer if limit has a finite duration
            if (limit.duration_nanoseconds && Number(limit.duration_nanoseconds) > 0) {
                const durationMs = Number(limit.duration_nanoseconds) / 1_000_000;
                this.startLimitDurationTimer(durationMs);
            }

            // Requirement 9.6: Start limit tracking (per-minute increment)
            this.#startLimitTracking();

            // Distribute limit to energy guards
            try {
                await this.#distributeLimit(true);
            } catch (err) {
                log.warn(`Failed to distribute LPP limit to guards: ${err.message}`);
            }
        } else {
            if (this.#fsm.can('heartbeatDeactivatedLimit')) {
                this.#fsm.heartbeatDeactivatedLimit();
                log.info(`LPP FSM transition: heartbeatDeactivatedLimit → ${this.state}`);
            }

            // Requirement 9.5: Set LPP.limit and LPP.limitDuration to 0 on deactivation
            this.#adapter.setState('LPP.limit', 0, true);
            this.#adapter.setState('LPP.limitDuration', 0, true);

            // Stop limit tracking
            this.#stopLimitTracking();

            // Deactivate limit on all energy guards
            try {
                await this.#distributeLimit(false);
            } catch (err) {
                log.warn(`Failed to deactivate LPP limit on guards: ${err.message}`);
            }
        }
    }

    /**
     * Handle LimitWriteApprovalRequired: approve or deny pending production limits.
     * Requirement 2.3: approve if limit >= sum of guard failsafe limits, deny otherwise.
     */
    async #handleLimitWriteApprovalRequired() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLppClient, 'PendingProductionLimit', {});

        log.debug(`PendingProductionLimit raw response: ${JSON.stringify(res)}`);

        const pending = res.load_limits || {};

        if (typeof pending !== 'object' || Array.isArray(pending)) {
            log.warn(`PendingProductionLimit: unexpected load_limits type (${typeof pending}) — skipping`);
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

        // Calculate sum of all LPP energy guard failsafe limits
        const failsafeSum = this.#guards.reduce((sum, guard) => sum + (guard.failsafeLimit || 0), 0);

        for (const [msgCounter, loadLimit] of entries) {
            if (typeof loadLimit !== 'object' || loadLimit === null) {
                log.warn(`PendingProductionLimit: skipping malformed entry key="${msgCounter}"`);
                continue;
            }

            const msgCounterNum = decodeMsgCounter(msgCounter);
            if (!Number.isFinite(msgCounterNum)) {
                log.warn(`PendingProductionLimit: skipping entry with undecodable key="${msgCounter}"`);
                continue;
            }

            const value = Math.abs(loadLimit.value || 0);

            if (value < failsafeSum) {
                const reason = `Limit ${value}W is below sum of guard failsafe limits (${failsafeSum}W)`;
                log.warn(`LPP: Denying pending limit msgCounter=${msgCounter} — ${reason}`);

                await callUnary(this.#csLppClient, 'ApproveOrDenyProductionLimit', {
                    msg_counter: msgCounterNum,
                    approve: false,
                    reason,
                });

                if (this.#fsm.can('heartbeatLimitNotApplicable')) {
                    this.#fsm.heartbeatLimitNotApplicable();
                    log.info(`LPP FSM transition: heartbeatLimitNotApplicable → ${this.state}`);
                }
            } else {
                log.info(
                    `LPP: Approving pending limit msgCounter=${msgCounterNum}, value=${value}W ` +
                        `(failsafe sum ${failsafeSum}W)`,
                );

                await callUnary(this.#csLppClient, 'ApproveOrDenyProductionLimit', {
                    msg_counter: msgCounterNum,
                    approve: true,
                    reason: '',
                });
            }
        }
    }

    /**
     * Handle DataUpdateFailsafeProductionActivePowerLimit: read and store failsafe limit.
     * Requirement 2.4: read and store the updated failsafe production limit value.
     */
    async #handleDataUpdateFailsafeLimit() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLppClient, 'FailsafeProductionActivePowerLimit', {});
        log.info(`LPP failsafe production limit update: value=${res.limit}, changeable=${res.is_changeable}`);
        this.#failsafeLimit = res.limit || 4200;
    }

    /**
     * Handle DataUpdateFailsafeDurationMinimum: read and store failsafe duration.
     * Requirement 2.5: read and store the updated failsafe duration value.
     */
    async #handleDataUpdateFailsafeDuration() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLppClient, 'FailsafeDurationMinimum', {});
        log.info(
            `LPP failsafe duration minimum update: ${res.duration_nanoseconds}ns, changeable=${res.is_changeable}`,
        );
        this.#failsafeDuration = res.duration_nanoseconds || 2 * 3600 * 1000000000;
    }

    /**
     * Handle DataUpdateHeartbeat: validate counter change, trigger FSM transitions.
     * Requirement 2.6: check counter change, trigger appropriate transition or heartbeatTimeout.
     */
    async #handleDataUpdateHeartbeat() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLppClient, 'IsHeartbeatWithinDuration', {});
        log.info(`LPP heartbeat update: withinDuration=${res.is_within_duration}`);

        if (!res.is_within_duration) {
            // Heartbeat counter did not change in time — trigger timeout
            if (this.#fsm.can('heartbeatTimeout')) {
                this.#fsm.heartbeatTimeout();
                log.warn(`LPP FSM transition: heartbeatTimeout → ${this.state}`);
            }
        } else if (this.state === LPP_STATE.INIT) {
            // Heartbeat received in init — read limit state and transition accordingly
            await this.#handleDataUpdateLimit();
        } else if (this.state === LPP_STATE.FAILSAFE) {
            // Heartbeat received in failsafe — if no limit write within 120s → unlimitedAutonomous
            this.startFailsafeHeartbeatTimer();
        }
    }

    // ─── EG-LPP Energy Guard Management ─────────────────────────────────

    /**
     * Initialize LPP Energy Guards from adapter configuration.
     * Creates guard instances, registers EG-LPP use cases for EEBUS guards,
     * and subscribes to EG-LPP events.
     *
     * Requirements: 8.1, 8.5, 8.6, 11.1, 11.2, 11.3, 11.4, 11.5
     */
    async #initEnergyGuards() {
        const config = this.#config;
        const log = this.#adapter.log;
        const guardConfigs = config.lppEnergyGuards || [];

        if (guardConfigs.length === 0) {
            // Still need to clean up any previously existing guard objects
            await this.#cleanupRemovedGuards(guardConfigs);
            return;
        }

        // Create LPP.EnergyGuards folder structure
        await this.#adapter.extendObjectAsync('LPP.EnergyGuards', {
            type: 'folder',
            common: { name: 'LPP Energy Guards' },
            native: {},
        });

        const seenSkis = new Set();
        this.#guards = [];
        this.#egLppEndpoints.clear();

        for (const entry of guardConfigs) {
            if (entry.type === 'eebus') {
                // Check for duplicate SKI (Requirement 8.5)
                if (seenSkis.has(entry.ski)) {
                    log.error(`Duplicate SKI detected for LPP energy guard "${entry.name}" — skipping`);
                    continue;
                }
                seenSkis.add(entry.ski);

                const guard = new EebusEnergyGuard(
                    this.#adapter,
                    entry.name,
                    entry.ski,
                    config.heartbeatTimeoutSeconds,
                    this.#translate,
                    { pathPrefix: 'LPP' },
                );
                await guard.createObjects();
                this.#guards.push(guard);

                // Register EG-LPP use case for this EEBUS guard (Requirement 8.1)
                try {
                    const entityAddr = this.#lpcEntityMap.get(entry.ski);
                    if (!entityAddr) {
                        log.error(`No EG entity found for LPP guard "${entry.name}" SKI=${entry.ski} — skipping`);
                        continue;
                    }

                    const res = await callUnary(this.#controlClient, 'AddUseCase', {
                        entity_address: { entity_address: entityAddr },
                        use_case: { actor: 'EnergyGuard', name: 'limitationOfPowerProduction' },
                    });
                    const endpoint = res.endpoint;
                    if (endpoint) {
                        this.#egLppEndpoints.set(entry.ski, { endpoint, entityAddr });
                        log.info(
                            `EG-LPP UseCase added for guard "${entry.name}" at entity [${entityAddr}], endpoint: ${endpoint}`,
                        );
                    } else {
                        // Requirement 8.6: empty endpoint — log error and continue
                        log.error(`AddUseCase returned empty endpoint for LPP guard "${entry.name}" — skipping EG-LPP`);
                    }
                } catch (err) {
                    // Requirement 8.6: registration failure — log error and continue
                    log.error(`Failed to add EG-LPP use case for guard "${entry.name}": ${err.message}`);
                }

                // Register the guard's SKI as trusted (Requirement 8.1)
                try {
                    await registerRemoteSki(this.#controlClient, entry.ski);
                    log.info(`Registered remote SKI for LPP guard "${entry.name}": ${entry.ski}`);
                } catch (err) {
                    log.error(`Failed to register remote SKI for LPP guard "${entry.name}": ${err.message}`);
                }
            } else if (entry.type === 'manual') {
                const guard = new ManualEnergyGuard(
                    this.#adapter,
                    entry.name,
                    config.heartbeatTimeoutSeconds,
                    this.#translate,
                    { pathPrefix: 'LPP' },
                );
                await guard.createObjects();
                this.#guards.push(guard);
            } else {
                log.warn(`Unknown LPP energy guard type "${entry.type}" for guard "${entry.name}" — skipping`);
            }
        }

        // Subscribe to EG-LPP use case events for pairing (Requirement 8.2)
        if (this.#egLppEndpoints.size > 0) {
            this.#subscribeEgLppEvents();
        }

        // Clean up objects for guards that were removed from config (Requirement 11.5)
        await this.#cleanupRemovedGuards(guardConfigs);

        log.info(`Initialized ${this.#guards.length} LPP energy guard(s)`);
    }

    /**
     * Remove ioBroker objects for LPP energy guards that are no longer in the configuration.
     * Compares existing Guard_* channels under LPP.EnergyGuards with the current config
     * and recursively deletes any that are no longer defined.
     *
     * Requirement 11.5: Delete guard channel and children when guard removed from config.
     *
     * @param {object[]} guardConfigs - Current LPP energy guard configuration entries
     */
    async #cleanupRemovedGuards(guardConfigs) {
        const log = this.#adapter.log;
        const adapterNamespace = this.#adapter.namespace;

        // Build set of expected guard channel IDs (without namespace prefix)
        const expectedNames = new Set(guardConfigs.map(entry => `LPP.EnergyGuards.Guard_${entry.name}`));

        try {
            // Get all objects under the adapter namespace
            const objects = await this.#adapter.getAdapterObjectsAsync();
            const channelIds = Object.keys(objects).filter(id => {
                const localId = id.replace(`${adapterNamespace}.`, '');
                return localId.startsWith('LPP.EnergyGuards.Guard_') && objects[id].type === 'channel';
            });

            for (const fullId of channelIds) {
                const localId = fullId.replace(`${adapterNamespace}.`, '');
                if (!expectedNames.has(localId)) {
                    log.info(`Removing objects for deleted LPP energy guard: ${localId}`);
                    // Delete all child states first, then the channel itself
                    const children = Object.keys(objects).filter(id => id.startsWith(`${fullId}.`));
                    for (const childId of children) {
                        await this.#adapter.delObjectAsync(childId.replace(`${adapterNamespace}.`, ''));
                    }
                    await this.#adapter.delObjectAsync(localId);
                }
            }
        } catch (err) {
            log.warn(`Failed to clean up removed LPP energy guard objects: ${err.message}`);
        }
    }

    /**
     * Subscribe to SubscribeUseCaseEvents for EG-LPP use cases.
     * Handles pairing (UseCaseSupportUpdate), heartbeat, and failsafe limit events.
     * Creates the EG-LPP control client only once on UseCaseSupportUpdate.
     *
     * Requirements: 8.2, 8.3, 8.4
     */
    #subscribeEgLppEvents() {
        const log = this.#adapter.log;

        for (const [ski, { endpoint, entityAddr }] of this.#egLppEndpoints) {
            const stream = this.#controlClient.SubscribeUseCaseEvents({
                entity_address: { entity_address: entityAddr },
                use_case: {
                    actor: 'EnergyGuard',
                    name: 'limitationOfPowerProduction',
                },
            });

            this.#egLppStreams.push(stream);

            stream.on('data', async evt => {
                const remoteSki = evt.remote_ski;
                const eventName = evt.use_case_event && evt.use_case_event.event;
                log.debug(
                    `EG-LPP event for entity [${entityAddr}]: remote_ski="${remoteSki || ''}", event=${eventName}`,
                );

                // Match incoming remote_ski to the guard with this SKI
                if (remoteSki !== ski) {
                    log.debug(`EG-LPP event SKI mismatch for guard SKI=${ski}: got remote_ski="${remoteSki || ''}"`);
                    return;
                }

                const guard = this.#guards.find(g => g instanceof EebusEnergyGuard && g.ski === ski);
                if (!guard) {
                    return;
                }

                if (eventName === 'UseCaseSupportUpdate') {
                    // Requirement 8.2: Create EG-LPP client on pairing (only if not already created)
                    if (!guard.egLpcClient) {
                        const remoteEntityAddr = evt.remote_entity_address && evt.remote_entity_address.entity_address;
                        const egLppClient = makeClient({
                            protoDir: PROTO_DIR,
                            protoRelPath: 'usecases/eg/lpp/service.proto',
                            pkg: 'eg_lpp',
                            service: 'EnergyGuardLPPControl',
                            endpoint,
                        });
                        guard.assignUseCaseClient(egLppClient, remoteSki, remoteEntityAddr);
                        log.info(
                            `EG-LPP client assigned to guard "${guard.name}" (SKI=${ski}, remoteEntity=[${remoteEntityAddr}])`,
                        );
                    }
                } else if (eventName === 'DataUpdateHeartbeat') {
                    // Requirement 8.3: Heartbeat event from the paired EG-LPP device
                    try {
                        await guard.handleHeartbeat();
                        log.silly(`LPP heartbeat received for guard "${guard.name}" (SKI=${ski})`);
                    } catch (err) {
                        log.warn(`Failed to handle LPP heartbeat for guard "${guard.name}": ${err.message}`);
                    }

                    // Re-distribute if a limit is currently active
                    if (this.#lastLimitActive) {
                        try {
                            await this.#distributeLimit(true);
                        } catch (err) {
                            log.warn(`Failed to re-distribute LPP limit after heartbeat: ${err.message}`);
                        }
                    }
                } else if (eventName === 'DataUpdateFailsafeProductionActivePowerLimit') {
                    // Requirement 8.4: Failsafe limit update from the remote device
                    // Use the EG-LPP client directly with the production-specific RPC name
                    try {
                        const egLppClient = guard.egLpcClient;
                        if (egLppClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLppClient, 'FailsafeProductionActivePowerLimit', {
                                remote_ski: ski,
                                remote_entity_address: { entity_address: remoteEntityAddr },
                            });
                            const failsafeValue = res.limit || 0;
                            await guard.setFailsafeLimit(failsafeValue);
                            log.info(`LPP failsafe limit updated for guard "${guard.name}": ${failsafeValue}W`);
                        }

                        // Re-distribute if limit is active (floor may have changed)
                        if (this.#lastLimitActive) {
                            await this.#distributeLimit(true);
                        }
                    } catch (err) {
                        log.warn(`Failed to read LPP failsafe limit for guard "${guard.name}": ${err.message}`);
                    }
                } else if (eventName === 'DataUpdateLimit') {
                    // Remote device confirmed the limit — read and update state
                    // Use EG-LPP client directly with production-specific RPC name
                    try {
                        const egLppClient = guard.egLpcClient;
                        if (egLppClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLppClient, 'ProductionLimit', {
                                remote_ski: ski,
                                remote_entity_address: { entity_address: remoteEntityAddr },
                            });
                            const limit = res.limit || {};
                            const isActive = !!limit.is_active;
                            const confirmedValue = isActive ? Math.abs(limit.value || 0) : 0;
                            await this.#adapter.setStateAsync(`${guard.basePath}.confirmedLimit`, confirmedValue, true);
                        }
                    } catch (err) {
                        log.warn(`Failed to handle DataUpdateLimit for LPP guard "${guard.name}": ${err.message}`);
                    }
                } else {
                    log.debug(`EG-LPP event "${eventName}" for guard "${guard.name}" — no action needed`);
                }
            });

            stream.on('error', err => {
                log.error(`EG-LPP event stream error for SKI=${ski}: ${err.message}`);
            });

            stream.on('end', () => {
                log.warn(`EG-LPP event stream ended for SKI=${ski}`);
            });
        }
    }

    // ─── Production Limit Distribution ──────────────────────────────────

    /**
     * Distribute a production limit to all LPP energy guards.
     * If inactive, deactivates all guards. Otherwise, uses the pure
     * `distributeProductionLimit` function for calculation and applies results.
     *
     * For EEBUS guards, the EG-LPP client uses `WriteProductionLimit` instead of
     * `WriteConsumptionLimit`, so we handle the gRPC writes directly here rather
     * than relying on the guard's `applyLimit()` which is LPC-specific.
     *
     * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
     *
     * @param {boolean} isActive - Whether the limit is active
     */
    async #distributeLimit(isActive) {
        const log = this.#adapter.log;
        log.info(`LPP distributeLimit called: isActive=${isActive}, guards=${this.#guards.length}`);
        this.#lastLimitActive = isActive;

        if (!isActive) {
            // Requirement 5.3: Deactivate on all guards regardless of connection state
            for (const guard of this.#guards) {
                try {
                    if (guard instanceof EebusEnergyGuard) {
                        // Deactivate: update state + send WriteProductionLimit(deactivate)
                        await this.#adapter.setStateAsync(`${guard.basePath}.currentLimit`, 0, true);
                        const egLppClient = guard.egLpcClient;
                        if (egLppClient && guard.isConnected()) {
                            await callUnary(egLppClient, 'WriteProductionLimit', {
                                remote_ski: guard.ski,
                                remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                                limit: { is_active: false, value: 0 },
                            });
                        }
                    } else {
                        await guard.deactivateLimit();
                    }
                } catch (err) {
                    log.warn(`Failed to deactivate LPP limit on guard "${guard.name}": ${err.message}`);
                }
            }
            return;
        }

        // Read the current controlbox production limit value
        let totalLimit = 0;
        try {
            const res = await callUnary(this.#csLppClient, 'ProductionLimit', {});
            const limit = res.load_limit || {};
            totalLimit = Math.abs(limit.value || 0);
            log.info(
                `LPP distributeLimit: read totalLimit=${totalLimit} (raw=${limit.value}, active=${limit.is_active})`,
            );
        } catch (err) {
            log.warn(`Failed to read production limit for distribution: ${err.message}`);
            return;
        }

        if (totalLimit <= 0) {
            log.warn('Production limit is active but value is 0 — skipping distribution');
            return;
        }

        // Read all percentages and connection states from guards
        const guardData = [];
        for (const guard of this.#guards) {
            const pct = await guard.getPercentage();
            const connected = guard.isConnected();
            guardData.push({ pct, connected, failsafeLimit: guard.failsafeLimit });
        }

        // Use pure distribution function
        const effectiveLimits = distributeProductionLimit(totalLimit, guardData);

        // Apply calculated limits to guards
        for (let i = 0; i < this.#guards.length; i++) {
            const guard = this.#guards[i];
            const limitInfo = effectiveLimits[i];
            try {
                if (limitInfo.skip) {
                    // Disconnected guard — set currentLimit to failsafe floor
                    await this.#adapter.setStateAsync(`${guard.basePath}.currentLimit`, guard.failsafeLimit, true);
                } else if (guard instanceof EebusEnergyGuard) {
                    // Connected EEBUS guard: calculate limit, update state, send via EG-LPP
                    const effectiveLimit = guard.calculateLimit(totalLimit, limitInfo.effectivePct);
                    await this.#adapter.setStateAsync(`${guard.basePath}.currentLimit`, effectiveLimit, true);
                    const egLppClient = guard.egLpcClient;
                    if (egLppClient && guard.isConnected()) {
                        await callUnary(egLppClient, 'WriteProductionLimit', {
                            remote_ski: guard.ski,
                            remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                            limit: { is_active: true, value: -effectiveLimit },
                        });
                    }
                } else {
                    // Manual guard: use base class applyLimit
                    await guard.applyLimit(totalLimit, limitInfo.effectivePct);
                }
            } catch (err) {
                log.warn(`Failed to apply LPP limit to guard "${guard.name}": ${err.message}`);
            }
        }
    }

    /**
     * Set the control box connected state.
     * When the control box connects with an active limit, reset any active manual limits
     * on EEBUS guards by sending WriteProductionLimit(deactivate) and cancelling timers.
     *
     * Requirement 14.3: Reset all manual limits when control box limit becomes active.
     *
     * @param {boolean} connected - Whether the control box is connected
     */
    async setControlBoxConnected(connected) {
        if (connected === this.#controlBoxConnected) {
            return;
        }
        this.#controlBoxConnected = connected;
        const log = this.#adapter.log;
        log.info(`LPP control box connection state: ${connected}`);

        if (connected) {
            // Reset manual limits on all EEBUS guards — control box takes over
            const eebusGuards = this.#guards.filter(g => g instanceof EebusEnergyGuard);
            await resetManualLimits(eebusGuards, this.#adapter, this.#manualLimitTimers, callUnary);
        }
    }

    // ─── FSM Lifecycle Methods ───────────────────────────────────────────

    /**
     * Called when the FSM enters a new state.
     * Starts timers for init and failsafe states per Requirements 3.3, 3.4, 3.6.
     * Updates LPP.state ioBroker object per Requirement 9.3.
     * Sets LPP.limit and LPP.limitDuration to 0 on non-limited states per Requirement 9.5.
     *
     * @param {object} lifecycle - { transition, from, to }
     */
    #onEnterState(lifecycle) {
        const log = this.#adapter.log;
        log.debug(`LPP FSM enter: ${lifecycle.from} → ${lifecycle.to} (${lifecycle.transition})`);

        // Requirement 9.3: Update LPP.state with new state string
        this.#adapter.setState('LPP.state', lifecycle.to, true);

        if (lifecycle.to === LPP_STATE.INIT) {
            // Requirement 3.3: start 120s init timeout
            this.#startInitTimer();
            // Requirement 9.5: no active limit in init
            this.#adapter.setState('LPP.limit', 0, true);
            this.#adapter.setState('LPP.limitDuration', 0, true);
        } else if (lifecycle.to === LPP_STATE.UNLIMITED_CONTROLLED) {
            // Requirement 9.5: limit deactivated
            this.#adapter.setState('LPP.limit', 0, true);
            this.#adapter.setState('LPP.limitDuration', 0, true);
            this.#stopLimitTracking();
        } else if (lifecycle.to === LPP_STATE.UNLIMITED_AUTONOMOUS) {
            // Requirement 9.5: no active limit
            this.#adapter.setState('LPP.limit', 0, true);
            this.#adapter.setState('LPP.limitDuration', 0, true);
            this.#stopLimitTracking();
        } else if (lifecycle.to === LPP_STATE.FAILSAFE) {
            // Requirement 3.4: start failsafe duration timer
            this.#startFailsafeTimer();
            // Requirement 9.5: failsafe state without active limit
            this.#adapter.setState('LPP.limit', 0, true);
            this.#adapter.setState('LPP.limitDuration', 0, true);
            this.#stopLimitTracking();
        }
    }

    /**
     * Called when the FSM leaves a state.
     * Cancels timers that are no longer relevant per Requirement 3.7.
     *
     * @param {object} lifecycle - { transition, from, to }
     */
    #onLeaveState(lifecycle) {
        if (lifecycle.from === LPP_STATE.INIT) {
            // Requirement 3.7: cancel init timeout when leaving init
            this.#clearInitTimer();
        } else if (lifecycle.from === LPP_STATE.FAILSAFE) {
            // Requirement 3.7: cancel failsafe duration timer and failsafe heartbeat timer
            this.#clearFailsafeTimer();
            this.#clearFailsafeHeartbeatTimer();
        } else if (lifecycle.from === LPP_STATE.LIMITED) {
            // Requirement 3.7: cancel limit duration timer when leaving limited
            this.#clearLimitDurationTimer();
        }
    }

    // ─── Timer Management ────────────────────────────────────────────────

    /**
     * Start the init timeout timer (120s).
     * Requirement 3.3: init → unlimitedAutonomous if no heartbeat with limit received.
     */
    #startInitTimer() {
        this.#clearInitTimer();
        const log = this.#adapter.log;
        this.#initTimer = this.#adapter.setTimeout(() => {
            if (this.#fsm.can('initTimeout')) {
                log.warn('LPP init timeout (120s) — no heartbeat/limit received, entering unlimitedAutonomous');
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
     * Requirement 3.4: failsafe → unlimitedAutonomous after failsafe duration minimum expires.
     * Uses the configured failsafe duration (default 2 hours).
     */
    #startFailsafeTimer() {
        this.#clearFailsafeTimer();
        const log = this.#adapter.log;

        // Default failsafe duration: 2 hours
        const durationMs = 2 * 3600 * 1000;

        log.info(`LPP failsafe timer started: ${durationMs}ms`);
        this.#failsafeTimer = this.#adapter.setTimeout(() => {
            if (this.#fsm.can('failsafeDurationExpired')) {
                log.warn('LPP failsafe duration expired — entering unlimitedAutonomous');
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
     * Requirement 3.6: if no production limit write arrives within 120s → unlimitedAutonomous.
     */
    startFailsafeHeartbeatTimer() {
        this.#clearFailsafeHeartbeatTimer();
        const log = this.#adapter.log;
        this.#failsafeHeartbeatTimer = this.#adapter.setTimeout(() => {
            if (this.#fsm.can('heartbeatNoFollowingLimit')) {
                log.warn(
                    'LPP: No limit received within 120s after heartbeat in failsafe — entering unlimitedAutonomous',
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
     * Transitions limited → unlimitedControlled when the activated limit's duration expires.
     *
     * @param {number} durationMs - Duration in milliseconds
     */
    startLimitDurationTimer(durationMs) {
        this.#clearLimitDurationTimer();
        if (!durationMs || durationMs <= 0) {
            return; // no duration set — limit is indefinite until explicitly deactivated
        }
        const log = this.#adapter.log;
        log.info(`LPP limit duration timer started: ${durationMs}ms`);
        this.#limitDurationTimer = this.#adapter.setTimeout(() => {
            if (this.#fsm.can('limitDurationExpired')) {
                log.info('LPP limit duration expired — entering unlimitedControlled');
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

    // ─── Limit Tracking ─────────────────────────────────────────────────

    /**
     * Start tracking limit-active time. Called when the production limit becomes active.
     * Schedules a per-minute accumulation tick and a midnight reset.
     * Requirement 9.6: increment LPP.limitMinutesToday by 1 per elapsed minute.
     */
    #startLimitTracking() {
        if (this.#limitActiveStartTime !== null) {
            return; // already tracking
        }
        this.#limitActiveStartTime = Date.now();

        // Accumulate every full minute while the limit is active
        this.#limitMinutesAccumTimer = this.#adapter.setInterval(async () => {
            this.#limitMinutesToday += 1;
            await this.#adapter.setStateAsync('LPP.limitMinutesToday', this.#limitMinutesToday, true);
        }, 60_000);

        // Requirement 9.7: schedule midnight reset
        this.#scheduleMidnightReset();
    }

    /**
     * Stop tracking limit-active time. Called when the production limit becomes inactive.
     */
    #stopLimitTracking() {
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
     * Requirement 9.7: reset LPP.limitMinutesToday to 0 at local midnight.
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
            await this.#adapter.setStateAsync('LPP.limitMinutesToday', 0, true);
            this.#adapter.log.info('LPP midnight reset: LPP.limitMinutesToday reset to 0');
            // Reschedule for the next midnight
            this.#scheduleMidnightReset();
        }, msUntilMidnight);
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
 * Determine whether a pending production limit should be approved or denied.
 *
 * Approval rule (Requirement 2.3):
 * Approve if pendingLimit >= sum of all guard failsafe limits; deny otherwise.
 * Values are expected to be positive (sign conversion happens at gRPC boundary).
 *
 * @param {number} pendingLimit - The pending production limit value in watts (positive)
 * @param {number[]} guardFailsafeLimits - Array of failsafe limit values (watts) for each configured guard
 * @returns {boolean} true if the limit should be approved, false if denied
 */
function shouldApproveLimit(pendingLimit, guardFailsafeLimits) {
    const failsafeSum = guardFailsafeLimits.reduce((sum, limit) => sum + limit, 0);
    return pendingLimit >= failsafeSum;
}

/**
 * Pure function to distribute a production limit across energy guards.
 *
 * Algorithm (Requirements 5.1, 5.2, 5.4, 5.5, 5.6):
 * 1. Separate guards into connected and disconnected
 * 2. Skip disconnected guards from proportional distribution
 * 3. Scale connected percentages if their sum exceeds 100%
 * 4. Redistribute disconnected guards' shares proportionally among connected guards
 * 5. Calculate effective limit as max(effectivePct * totalLimit / 100, failsafeLimit)
 *
 * @param {number} totalLimit - The total production limit to distribute (watts)
 * @param {Array<{pct: number, connected: boolean, failsafeLimit: number}>} guards - Guard data
 * @returns {Array<{effectivePct: number, effectiveLimit: number, skip: boolean}>} Distribution result per guard
 */
function distributeProductionLimit(totalLimit, guards) {
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

    // Scale percentages if sum > 100% (Requirement 5.2)
    const scale = connectedSum > 100 ? 100 / connectedSum : 1;
    const scaledPcts = connectedPcts.map(p => p * scale);

    // The total "bucket" for connected guards includes any disconnected shares
    // that should be redistributed (Requirement 5.6).
    // Disconnected guards' shares are redistributed proportionally among connected guards.
    const disconnectedPctSum = disconnectedIndices.reduce((acc, i) => acc + guards[i].pct, 0);
    const scaledConnectedSum = scaledPcts.reduce((acc, p) => acc + p, 0);

    // Redistribute disconnected shares proportionally among connected guards
    let effectivePcts;
    if (scaledConnectedSum > 0 && disconnectedPctSum > 0) {
        // Each connected guard gets its share + proportional portion of disconnected shares
        // Scale disconnected pctSum the same way as connected pcts for consistency
        const disconnectedScaled = disconnectedPctSum * scale;
        effectivePcts = scaledPcts.map(p => p + (p / scaledConnectedSum) * disconnectedScaled);
    } else {
        effectivePcts = scaledPcts;
    }

    // Calculate effective limits for each connected guard (Requirement 5.5)
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

/**
 * Reset manual limits on all EEBUS energy guards.
 *
 * When the control box limit becomes active, all manual limits must be deactivated:
 * - Cancel any running manual limit timers
 * - Send WriteProductionLimit(deactivate) to connected guards via their EG-LPP client
 * - Reset manualLimit ioBroker state to 0
 *
 * Requirement 14.3: Reset all manual limits when control box limit becomes active.
 *
 * @param {Array<{name: string, basePath: string, egLpcClient: object|null, isConnected: () => boolean, ski: string}>} guards - Array of EEBUS guard-like objects
 * @param {object} adapter - ioBroker adapter instance (provides setStateAsync, clearTimeout, log)
 * @param {Map<string, number>} manualLimitTimers - Map of guard name → active timer ID
 * @param {(client: object, method: string, request: object) => Promise} callUnaryFn - gRPC callUnary function
 * @returns {Promise<void>}
 */
async function resetManualLimits(guards, adapter, manualLimitTimers, callUnaryFn) {
    for (const guard of guards) {
        // Cancel the manual limit timer for this guard
        const timer = manualLimitTimers.get(guard.name);
        if (timer) {
            adapter.clearTimeout(timer);
            manualLimitTimers.delete(guard.name);
        }

        // Send deactivate WriteProductionLimit if client is available
        const egLppClient = guard.egLpcClient;
        if (egLppClient && guard.isConnected()) {
            try {
                await callUnaryFn(egLppClient, 'WriteProductionLimit', {
                    remote_ski: guard.ski,
                    remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                    limit: { is_active: false, value: 0 },
                });
            } catch (err) {
                adapter.log.warn(
                    `Failed to deactivate manual production limit for LPP guard "${guard.name}": ${err.message}`,
                );
            }
        }

        // Reset the manualLimit state to 0
        await adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
    }
}

/**
 * Filter duplicate SKIs from an array of guard configurations.
 * Only the first occurrence of each unique SKI is kept; subsequent duplicates are skipped.
 *
 * This is the pure logic extracted from LppUseCase#initEnergyGuards() (Requirement 8.5).
 *
 * @param {Array<{name: string, type: string, ski: string, brand: string}>} guardConfigs - Array of guard configuration entries to filter
 * @returns {Array<{name: string, type: string, ski: string, brand: string}>} Filtered configs with unique SKIs
 */
function filterDuplicateSkis(guardConfigs) {
    const seenSkis = new Set();
    const result = [];
    for (const entry of guardConfigs) {
        if (seenSkis.has(entry.ski)) {
            continue;
        }
        seenSkis.add(entry.ski);
        result.push(entry);
    }
    return result;
}

module.exports = {
    LppUseCase,
    LPP_STATE,
    LPP_TRANSITIONS,
    shouldApproveLimit,
    distributeProductionLimit,
    resetManualLimits,
    filterDuplicateSkis,
};
