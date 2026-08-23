'use strict';

const path = require('node:path');
const StateMachine = require('javascript-state-machine');
const { makeClient, callUnary, isTransportError, getEndpoint } = require('./grpc-client');

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
    #csLppInstanceId;
    #fsm;
    #initTimer;
    #failsafeTimer;
    #failsafeHeartbeatTimer;
    #limitDurationTimer;
    #heartbeatCheckTimer;
    #eventStream;
    #failsafeLimit; // eslint-disable-line no-unused-private-class-members -- updated by event handler, read for approval logic
    #failsafeDuration; // eslint-disable-line no-unused-private-class-members -- updated by event handler, used for failsafe timer
    #lastHeartbeatCounter; // eslint-disable-line no-unused-private-class-members -- updated by event handler, used for counter validation
    #limitMinutesToday;
    #limitActiveStartTime;
    #limitMinutesAccumTimer;
    #midnightResetTimer;
    #onLimitUpdate;
    #onControlBoxConnected; // eslint-disable-line no-unused-private-class-members -- reserved for external coordination
    #getGuardFailsafeLimits;
    #onGrpcError;

    /**
     * Create a new LppUseCase instance.
     *
     * @param {object} adapter - ioBroker adapter instance (provides config, log, setState, setTimeout, etc.)
     * @param {object} config - Adapter configuration (native object)
     * @param {object} controlClient - gRPC ControlService client (shared with HEMS coordinator)
     * @param {(key: string) => string} translate - I18n translate function
     * @param {object} [callbacks] - Optional callback functions
     * @param {(isActive: boolean, limitValue: number) => Promise<void>} [callbacks.onLimitUpdate] - Called when limit updates
     * @param {(connected: boolean) => Promise<void>} [callbacks.onControlBoxConnected] - Called when control box connection state changes
     * @param {() => number[]} [callbacks.getGuardFailsafeLimits] - Returns array of guard failsafe limit values
     * @param {() => void} [callbacks.onGrpcError] - Called when a gRPC transport error occurs (triggers reconnect)
     */
    constructor(
        adapter,
        config,
        controlClient,
        translate,
        { onLimitUpdate, onControlBoxConnected, getGuardFailsafeLimits, onGrpcError } = {},
    ) {
        this.#adapter = adapter;
        this.#config = config;
        this.#controlClient = controlClient;
        this.#translate = translate || (key => key);
        this.#csLppClient = null;
        this.#csLppInstanceId = null;
        this.#initTimer = null;
        this.#failsafeTimer = null;
        this.#failsafeHeartbeatTimer = null;
        this.#limitDurationTimer = null;
        this.#heartbeatCheckTimer = null;
        this.#eventStream = null;
        this.#failsafeLimit = 4200;
        this.#failsafeDuration = 2 * 3600 * 1000000000; // 2h in nanoseconds
        this.#lastHeartbeatCounter = null;
        this.#limitMinutesToday = 0;
        this.#limitActiveStartTime = null;
        this.#limitMinutesAccumTimer = null;
        this.#midnightResetTimer = null;
        this.#onLimitUpdate = onLimitUpdate || (() => {});
        this.#onControlBoxConnected = onControlBoxConnected || (() => {});
        this.#getGuardFailsafeLimits = getGuardFailsafeLimits || (() => []);
        this.#onGrpcError = onGrpcError || (() => {});

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
     * Expose the CS-LPP gRPC client so EgLpp can use it for SetFailsafe.
     *
     * @returns {object|null} The CS-LPP gRPC client, or null if not yet created
     */
    get csClient() {
        return this.#csLppClient;
    }

    /**
     * Expose the CS-LPP instance ID so EgLpp can include it in RPC calls.
     *
     * @returns {string|null} The CS-LPP instance ID, or null if not yet registered
     */
    get csInstanceId() {
        return this.#csLppInstanceId;
    }

    /**
     * Start the LPP use case.
     * Registers CS-LPP use case, creates clients, subscribes to events.
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
                role: 'value.interval',
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
        const res = await callUnary(this.#controlClient, 'AddUseCase', {
            entity_address: { entity_address: [1] },
            use_case: { actor: 'ControllableSystem', name: 'limitationOfPowerProduction' },
        });
        const csLppInstanceId = res.instance_id;

        // Handle empty instance_id: treat as failed registration
        if (!csLppInstanceId) {
            throw new Error('CS-LPP use case registration returned empty instance_id');
        }

        log.info(`CS-LPP UseCase added with instance_id: ${csLppInstanceId}`);

        // Create CS-LPP gRPC client at the same endpoint as the control client
        this.#csLppClient = makeClient({
            protoDir: PROTO_DIR,
            protoRelPath: 'usecases/cs/lpp/service.proto',
            pkg: 'cs_lpp',
            service: 'ControllableSystemLPPControl',
            endpoint: getEndpoint(this.#controlClient),
        });
        this.#csLppInstanceId = csLppInstanceId;

        // Configure initial parameters (negate values for EEBUS production sign convention)
        const nominalMax = this.#config.contractualProductionNominalMax || 4200;
        await callUnary(this.#csLppClient, 'SetProductionNominalMax', {
            instance_id: csLppInstanceId,
            value: -nominalMax,
        });
        await callUnary(this.#csLppClient, 'SetProductionLimit', {
            instance_id: csLppInstanceId,
            load_limit: {
                is_changeable: true,
                is_active: false,
                value: -4200,
            },
        });
        await callUnary(this.#csLppClient, 'SetFailsafeProductionActivePowerLimit', {
            instance_id: csLppInstanceId,
            value: -nominalMax,
            is_changeable: false,
        });
        await callUnary(this.#csLppClient, 'SetFailsafeDurationMinimum', {
            instance_id: csLppInstanceId,
            is_changeable: false,
            duration_nanoseconds: 2 * 3600 * 1000000000, // 2h in ns
        });

        log.info('CS-LPP client configured with initial parameters');

        // Start CS heartbeat so connected controlboxes/EG devices receive it
        await callUnary(this.#csLppClient, 'StartHeartbeat', { instance_id: csLppInstanceId });

        // Subscribe to CS-LPP events
        this.#subscribeCsLppEvents();

        this.#startInitTimer();
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
        // Cancel CS-LPP event stream
        if (this.#eventStream) {
            this.#eventStream.cancel();
            this.#eventStream = null;
        }
        // Close CS-LPP client
        if (this.#csLppClient && this.#csLppClient.close) {
            this.#csLppClient.close();
            this.#csLppClient = null;
        }
    }

    /**
     * Trigger FSM restart transition. Resets to init state.
     * Valid from: any state → init
     */
    restart() {
        this.#fsm.restart();
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
            instance_id: this.#csLppInstanceId,
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
                    // Only process heartbeat from the controlbox — ignore heartbeats from EG devices
                    if (evt.remote_ski === this.#config.controlboxSki) {
                        await this.#handleDataUpdateHeartbeat();
                    }
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
        const res = await callUnary(this.#csLppClient, 'ProductionLimit', { instance_id: this.#csLppInstanceId });
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

            // Notify the limit update callback
            await this.#onLimitUpdate(true, limitValue);
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

            // Notify the limit update callback
            await this.#onLimitUpdate(false, 0);
        }
    }

    /**
     * Handle LimitWriteApprovalRequired: approve or deny pending production limits.
     * Requirement 2.3: approve if limit >= sum of guard failsafe limits, deny otherwise.
     */
    async #handleLimitWriteApprovalRequired() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLppClient, 'PendingProductionLimit', {
            instance_id: this.#csLppInstanceId,
        });

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
        const guardFailsafeLimits = this.#getGuardFailsafeLimits();
        const failsafeSum = guardFailsafeLimits.reduce((sum, limit) => sum + limit, 0);

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
                    instance_id: this.#csLppInstanceId,
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
                    instance_id: this.#csLppInstanceId,
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
        const res = await callUnary(this.#csLppClient, 'FailsafeProductionActivePowerLimit', {
            instance_id: this.#csLppInstanceId,
        });
        log.info(`LPP failsafe production limit update: value=${res.limit}, changeable=${res.is_changeable}`);
        this.#failsafeLimit = res.limit || 4200;
    }

    /**
     * Handle DataUpdateFailsafeDurationMinimum: read and store failsafe duration.
     * Requirement 2.5: read and store the updated failsafe duration value.
     */
    async #handleDataUpdateFailsafeDuration() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLppClient, 'FailsafeDurationMinimum', {
            instance_id: this.#csLppInstanceId,
        });
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
        const res = await callUnary(this.#csLppClient, 'IsHeartbeatWithinDuration', {
            instance_id: this.#csLppInstanceId,
        });
        log.info(`LPP heartbeat update: withinDuration=${res.is_within_duration}`);

        if (!res.is_within_duration) {
            // Heartbeat counter did not change in time — trigger timeout
            if (this.#fsm.can('heartbeatTimeout')) {
                this.#fsm.heartbeatTimeout();
                log.warn(`LPP FSM transition: heartbeatTimeout → ${this.state}`);
            }
        } else if (this.state === LPP_STATE.INIT || this.state === LPP_STATE.UNLIMITED_AUTONOMOUS) {
            // Heartbeat received in init or unlimitedAutonomous — read limit state and transition
            await this.#handleDataUpdateLimit();
        } else if (this.state === LPP_STATE.FAILSAFE) {
            // Heartbeat received in failsafe — read limit to transition out, start 120s fallback timer
            this.startFailsafeHeartbeatTimer();
            await this.#handleDataUpdateLimit();
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
            this.#startHeartbeatCheckTimer();
            this.#adapter.setState('LPP.limit', 0, true);
            this.#adapter.setState('LPP.limitDuration', 0, true);
            this.#stopLimitTracking();
        } else if (lifecycle.to === LPP_STATE.LIMITED) {
            this.#startHeartbeatCheckTimer();
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
            // Distribute failsafe limits to energy guards
            this.#updateFailsafeLimitState();
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
        } else if (lifecycle.from === LPP_STATE.UNLIMITED_CONTROLLED) {
            this.#clearHeartbeatCheckTimer();
        } else if (lifecycle.from === LPP_STATE.LIMITED) {
            // Requirement 3.7: cancel limit duration timer when leaving limited
            this.#clearLimitDurationTimer();
            this.#clearHeartbeatCheckTimer();
        } else if (lifecycle.from === LPP_STATE.FAILSAFE) {
            // Requirement 3.7: cancel failsafe duration timer and failsafe heartbeat timer
            this.#clearFailsafeTimer();
            this.#clearFailsafeHeartbeatTimer();
        }
    }

    /**
     * Read the failsafe limit and distribute to energy guards.
     * Called when entering failsafe state.
     */
    async #updateFailsafeLimitState() {
        try {
            const res = await callUnary(this.#csLppClient, 'FailsafeProductionActivePowerLimit', {
                instance_id: this.#csLppInstanceId,
            });
            const failsafeLimit = Math.abs(res.limit || 0);
            this.#adapter.setState('LPP.limit', failsafeLimit, true);
            // Distribute failsafe limit to energy guards
            await this.#onLimitUpdate(true, failsafeLimit);
        } catch (err) {
            if (isTransportError(err)) {
                this.#adapter.log.error(
                    `LPP failsafe limit read gRPC transport error: ${err.message} — triggering reconnect`,
                );
                this.#onGrpcError();
            } else {
                this.#adapter.log.warn(`Failed to read failsafe limit for LPP.limit: ${err.message}`);
            }
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
     * Start periodic heartbeat check timer.
     * Polls IsHeartbeatWithinDuration at the configured interval to detect
     * controlbox disconnection even when no heartbeat events arrive.
     */
    #startHeartbeatCheckTimer() {
        this.#clearHeartbeatCheckTimer();
        const intervalMs = Math.min(Math.max(this.#config.heartbeatTimeoutSeconds || 30, 5), 600) * 1000;
        this.#heartbeatCheckTimer = this.#adapter.setInterval(async () => {
            try {
                const res = await callUnary(this.#csLppClient, 'IsHeartbeatWithinDuration', {
                    instance_id: this.#csLppInstanceId,
                });
                if (!res.is_within_duration) {
                    if (this.#fsm.can('heartbeatTimeout')) {
                        this.#adapter.log.warn(
                            'LPP heartbeat check: withinDuration=false — triggering heartbeatTimeout',
                        );
                        this.#fsm.heartbeatTimeout();
                    }
                }
            } catch (err) {
                if (isTransportError(err)) {
                    this.#adapter.log.error(
                        `LPP heartbeat check gRPC transport error: ${err.message} — triggering reconnect`,
                    );
                    this.#onGrpcError();
                } else {
                    this.#adapter.log.warn(`LPP heartbeat check failed: ${err.message}`);
                }
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
        this.#limitDurationTimer = this.#adapter.setTimeout(async () => {
            if (this.#fsm.can('limitDurationExpired')) {
                log.info('LPP limit duration expired — entering unlimitedControlled');
                this.#fsm.limitDurationExpired();
                await this.#onLimitUpdate(false, 0);
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

    // Separate connected vs disconnected.
    // Disconnected guards will still produce up to their failsafe power,
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
    // Scale percentages only if sum > 100% (Requirement 5.2).
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
    // (Requirement 5.5)
    for (let j = 0; j < connectedIndices.length; j++) {
        if (pinned[j]) {
            continue;
        }
        const i = connectedIndices[j];
        results[i].effectivePct = effectivePcts[j];
        results[i].effectiveLimit = (effectivePcts[j] / 100) * remainingBudget;
    }

    // Enforce a minimum of 1W for all connected guards so that users and scripts
    // can distinguish "limited" (currentLimit >= 1) from "no limit" (currentLimit = 0).
    for (const j of connectedIndices) {
        if (!results[j].skip && results[j].effectiveLimit < 1) {
            results[j].effectiveLimit = 1;
        }
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
                    instance_id: guard.instanceId,
                    remote_ski: guard.ski,
                    remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                    limit: { is_active: false, value: 0 },
                });
            } catch (err) {
                adapter.log.warn(`Failed to reset manual production limit for guard "${guard.name}": ${err.message}`);
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
