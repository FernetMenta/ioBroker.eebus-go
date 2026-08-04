'use strict';

const path = require('node:path');
const StateMachine = require('javascript-state-machine');
const { makeClient, callUnary } = require('./grpc-client');
const { addCsLpcUseCase, subscribeCsLpcEvents } = require('./grpc-service');

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
    #csLpcClient;
    #fsm;
    #initTimer;
    #failsafeTimer;
    #failsafeHeartbeatTimer;
    #limitDurationTimer;
    #heartbeatCheckTimer;
    #lpcStream;
    #limitMinutesToday;
    #limitActiveStartTime;
    #limitMinutesAccumTimer;
    #midnightResetTimer;
    #onLimitUpdate;
    #onControlBoxConnected;
    #getGuardFailsafeLimits;

    /**
     * Create a new LpcUseCase instance.
     *
     * @param {object} adapter - ioBroker adapter instance (provides config, log, setState, setTimeout, etc.)
     * @param {object} config - Adapter configuration (native object)
     * @param {object} controlClient - gRPC ControlService client (shared with HEMS coordinator)
     * @param {(key: string) => string} translate - I18n translate function
     * @param {object} [callbacks] - Optional callback functions
     * @param {(isActive: boolean, limitValue: number) => Promise<void>} [callbacks.onLimitUpdate] - Called when limit updates
     * @param {(connected: boolean) => Promise<void>} [callbacks.onControlBoxConnected] - Called when control box connection state changes
     * @param {() => number[]} [callbacks.getGuardFailsafeLimits] - Returns array of guard failsafe limit values
     */
    constructor(
        adapter,
        config,
        controlClient,
        translate,
        { onLimitUpdate, onControlBoxConnected, getGuardFailsafeLimits } = {},
    ) {
        this.#adapter = adapter;
        this.#config = config;
        this.#controlClient = controlClient;
        this.#csLpcClient = null;
        this.#initTimer = null;
        this.#failsafeTimer = null;
        this.#failsafeHeartbeatTimer = null;
        this.#limitDurationTimer = null;
        this.#heartbeatCheckTimer = null;
        this.#lpcStream = null;
        this.#limitMinutesToday = 0;
        this.#limitActiveStartTime = null;
        this.#limitMinutesAccumTimer = null;
        this.#midnightResetTimer = null;
        this.#onLimitUpdate = onLimitUpdate || (() => {});
        this.#onControlBoxConnected = onControlBoxConnected || (() => {});
        this.#getGuardFailsafeLimits = getGuardFailsafeLimits || (() => []);

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
     * Expose the CS-LPC gRPC client so EgLpc can use it for SetFailsafe.
     *
     * @returns {object|null} The CS-LPC gRPC client, or null if not yet created
     */
    get csClient() {
        return this.#csLpcClient;
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
            value: nominalMax,
            is_changeable: false,
        });
        await callUnary(this.#csLpcClient, 'SetFailsafeDurationMinimum', {
            is_changeable: false,
            duration_nanoseconds: 2 * 3600 * 1000000000, // 2h in ns
        });

        log.info('CS-LPC client configured with initial parameters');

        // Subscribe to CS-LPC events
        this.#subscribeCsLpcEvents();

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
        this.#clearHeartbeatCheckTimer();
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
    }

    /**
     * Trigger FSM restart transition. Resets to init state.
     * Valid from: any state → init
     */
    restart() {
        this.#fsm.restart();
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
                // Only process heartbeat from the controlbox — ignore heartbeats from EG devices
                if (evt.remote_ski === this.#config.controlboxSki) {
                    await this.#handleDataUpdateHeartbeat();
                    await this.#onControlBoxConnected(true);
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

        // Track limit-active time
        if (limit.is_active) {
            this.#startLimitTracking();
        } else {
            await this.#stopLimitTracking();
        }

        // Notify the limit update callback
        await this.#onLimitUpdate(!!limit.is_active, limitValue);
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
        const guardFailsafeLimits = this.#getGuardFailsafeLimits();
        const failsafeSum = guardFailsafeLimits.reduce((sum, limit) => sum + limit, 0);

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
        } else if (this.state === LPC_STATE.INIT || this.state === LPC_STATE.UNLIMITED_AUTONOMOUS) {
            // Heartbeat received in init or unlimitedAutonomous — read limit state and transition
            await this.#handleDataUpdateLimit();
        } else if (this.state === LPC_STATE.FAILSAFE) {
            // Heartbeat received in failsafe — read limit to transition out, start 120s fallback timer
            this.#startFailsafeHeartbeatTimer();
            await this.#handleDataUpdateLimit();
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
            this.#onControlBoxConnected(false);
            this.#adapter.setState('LPC.limit', 0, true);
            this.#adapter.setState('LPC.limitDuration', 0, true);
        } else if (lifecycle.to === LPC_STATE.UNLIMITED_CONTROLLED) {
            this.#startHeartbeatCheckTimer();
            this.#adapter.setState('LPC.limit', 0, true);
            this.#adapter.setState('LPC.limitDuration', 0, true);
        } else if (lifecycle.to === LPC_STATE.LIMITED) {
            this.#startHeartbeatCheckTimer();
        } else if (lifecycle.to === LPC_STATE.UNLIMITED_AUTONOMOUS) {
            // Init timeout or failsafe expired — control box is gone
            this.#onControlBoxConnected(false);
            this.#adapter.setState('LPC.limit', 0, true);
            this.#adapter.setState('LPC.limitDuration', 0, true);
        } else if (lifecycle.to === LPC_STATE.FAILSAFE) {
            // After failsafe duration minimum expires → unlimitedAutonomous
            this.#startFailsafeTimer();
            this.#onControlBoxConnected(false);
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
        } else if (lifecycle.from === LPC_STATE.UNLIMITED_CONTROLLED) {
            this.#clearHeartbeatCheckTimer();
        } else if (lifecycle.from === LPC_STATE.LIMITED) {
            this.#clearLimitDurationTimer();
            this.#clearHeartbeatCheckTimer();
        } else if (lifecycle.from === LPC_STATE.FAILSAFE) {
            this.#clearFailsafeTimer();
            this.#clearFailsafeHeartbeatTimer();
        }
    }

    /**
     * Read the failsafe limit and write it to LPC.limit.
     * Called when entering failsafe state.
     */
    async #updateFailsafeLimitState() {
        try {
            const res = await callUnary(this.#csLpcClient, 'FailsafeConsumptionActivePowerLimit', {});
            const failsafeLimit = res.limit || 0;
            this.#adapter.setState('LPC.limit', failsafeLimit, true);
            // Distribute failsafe limit to energy guards
            await this.#onLimitUpdate(true, failsafeLimit);
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
     * Start periodic heartbeat check timer.
     * Polls IsHeartbeatWithinDuration at the configured interval to detect
     * controlbox disconnection even when no heartbeat events arrive.
     */
    #startHeartbeatCheckTimer() {
        this.#clearHeartbeatCheckTimer();
        const intervalMs = (this.#config.heartbeatTimeoutSeconds || 30) * 1000;
        this.#heartbeatCheckTimer = this.#adapter.setInterval(async () => {
            try {
                const res = await callUnary(this.#csLpcClient, 'IsHeartbeatWithinDuration', {});
                if (!res.is_within_duration) {
                    if (this.#fsm.can('heartbeatTimeout')) {
                        this.#adapter.log.warn(
                            'LPC heartbeat check: withinDuration=false — triggering heartbeatTimeout',
                        );
                        this.#fsm.heartbeatTimeout();
                    }
                }
            } catch (err) {
                this.#adapter.log.warn(`LPC heartbeat check failed: ${err.message}`);
            }
        }, intervalMs);
    }

    /**
     * Clear the periodic heartbeat check timer.
     */
    #clearHeartbeatCheckTimer() {
        if (this.#heartbeatCheckTimer) {
            this.#adapter.clearInterval(this.#heartbeatCheckTimer);
            this.#heartbeatCheckTimer = null;
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

    // Separate connected vs disconnected.
    // Disconnected guards will still draw up to their failsafe power,
    // so reserve that from the budget.
    const connectedIndices = [];
    let disconnectedFailsafeSum = 0;

    for (let i = 0; i < guards.length; i++) {
        if (guards[i].connected) {
            connectedIndices.push(i);
        } else {
            results[i].skip = true;
            results[i].effectiveLimit = guards[i].failsafeLimit;
            disconnectedFailsafeSum += guards[i].failsafeLimit;
        }
    }

    if (connectedIndices.length === 0) {
        return results;
    }

    // Each guard gets its configured percentage of totalLimit — no redistribution.
    // Scale percentages only if sum > 100% (to avoid exceeding the total budget).
    const connectedPcts = connectedIndices.map(i => guards[i].pct);
    const connectedSum = connectedPcts.reduce((acc, p) => acc + p, 0);
    const scale = connectedSum > 100 ? 100 / connectedSum : 1;
    const effectivePcts = connectedPcts.map(p => p * scale);

    // Iterative distribution: pin guards at failsafe floor if their percentage-based
    // share is below their failsafe. Pinned guards consume budget from the total,
    // reducing the remaining budget for unpinned guards.
    const pinned = new Array(connectedIndices.length).fill(false);
    let remainingBudget = Math.max(0, totalLimit - disconnectedFailsafeSum);
    let changed = true;

    while (changed) {
        changed = false;

        for (let j = 0; j < connectedIndices.length; j++) {
            if (pinned[j]) {
                continue;
            }
            const i = connectedIndices[j];
            const proportionalShare = (effectivePcts[j] / 100) * remainingBudget;

            if (proportionalShare < guards[i].failsafeLimit) {
                // Pin this guard at its failsafe limit
                pinned[j] = true;
                results[i].effectiveLimit = guards[i].failsafeLimit;
                results[i].effectivePct = effectivePcts[j];
                remainingBudget -= guards[i].failsafeLimit;
                changed = true;
                break; // restart with updated budget
            }
        }
    }

    // Distribute to unpinned guards: each gets its percentage of the remaining budget.
    // The remaining budget is totalLimit minus what pinned guards consumed (failsafe floors).
    // This means unpinned guards never get more than their configured percentage of the
    // original totalLimit — they can only get less if pinned guards took a larger share.
    for (let j = 0; j < connectedIndices.length; j++) {
        if (pinned[j]) {
            continue;
        }
        const i = connectedIndices[j];
        results[i].effectivePct = effectivePcts[j];
        results[i].effectiveLimit = (effectivePcts[j] / 100) * remainingBudget;
    }

    return results;
}

module.exports = { LpcUseCase, LPC_STATE, LPC_TRANSITIONS, shouldApproveLimit, distributeConsumptionLimit };
