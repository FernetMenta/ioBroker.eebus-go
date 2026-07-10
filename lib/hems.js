'use strict';

const path = require('path');
const StateMachine = require('javascript-state-machine');
const { makeClient, callUnary } = require('./grpc-cslpc');
const {
    resetService,
    setConfig,
    startSetup,
    addCsLpcUseCase,
    registerRemoteSki,
    startService,
    subscribeCsLpcEvents,
} = require('./grpc-service');
const { EebusEnergyGuard, ManualEnergyGuard } = require('./energy-guard');

/**
 * Root directory for protobuf definitions.
 */
const PROTO_DIR = path.join(__dirname, 'protobuf');

/**
 * LPC states as defined in EEBus UC TS - Limitation of Power Consumption V1.0.0 §2.3.2
 */
const STATE = Object.freeze({
    INIT: 'init',
    UNLIMITED_CONTROLLED: 'unlimitedControlled',
    LIMITED: 'limited',
    FAILSAFE: 'failsafe',
    UNLIMITED_AUTONOMOUS: 'unlimitedAutonomous',
});

/**
 * HEMS class encapsulating the LPC finite state machine for the Controllable System actor.
 *
 * States (§2.3.2):
 *  - init: CS starts here after (re)start, limited by failsafe power limit
 *  - unlimitedControlled: CS not limited, but controlled by Energy Guard
 *  - limited: CS in limited state, controlled by Energy Guard
 *  - failsafe: CS not controlled by Energy Guard, limited by failsafe limit
 *  - unlimitedAutonomous: CS not limited, consumes as if no external limitation exists
 *
 * Transitions (§2.3.3):
 *  0: ● → init (restart)
 *  1: init → unlimitedControlled
 *  2: init → limited
 *  3: init → unlimitedAutonomous
 *  4: unlimitedControlled → limited
 *  5: unlimitedControlled → failsafe
 *  6: limited → unlimitedControlled
 *  7: limited → failsafe
 *  8: failsafe → unlimitedControlled
 *  9: failsafe → limited
 * 10: failsafe → unlimitedAutonomous
 * 11: unlimitedAutonomous → unlimitedControlled
 * 12: unlimitedAutonomous → limited
 */
class Hems {
    #adapter;
    #config;
    #controlClient;
    #csLpcClient;
    #discoveryStream;
    #discoveredDevices;
    #lpcStream;
    #initTimer;
    #failsafeTimer;
    #failsafeHeartbeatTimer;
    #limitDurationTimer;
    #retryTimer;
    #fsm;
    #energyGuards;
    #egLpcEndpoints;
    #consumptionNominalMax;
    #lastLimitActive;

    /**
     * Create a new HEMS instance.
     *
     * @param {object} adapter - ioBroker adapter instance (provides config, log, setState, etc.)
     */
    constructor(adapter) {
        this.#adapter = adapter;
        this.#config = adapter.config;
        this.#controlClient = null;
        this.#csLpcClient = null;
        this.#discoveryStream = null;
        this.#discoveredDevices = new Map();
        this.#lpcStream = null;
        this.#initTimer = null;
        this.#failsafeTimer = null;
        this.#failsafeHeartbeatTimer = null;
        this.#limitDurationTimer = null;
        this.#retryTimer = null;
        this.#energyGuards = [];
        this.#egLpcEndpoints = new Map();
        this.#consumptionNominalMax = adapter.config.consumptionNominalMax || 0;
        this.#lastLimitActive = false;

        this.#fsm = new StateMachine({
            init: STATE.INIT,
            transitions: [
                // T1: init → unlimitedControlled
                { name: 'heartbeatDeactivatedLimit', from: STATE.INIT, to: STATE.UNLIMITED_CONTROLLED },
                { name: 'heartbeatLimitNotApplicable', from: STATE.INIT, to: STATE.UNLIMITED_CONTROLLED },

                // T2: init → limited
                { name: 'heartbeatActivatedLimit', from: STATE.INIT, to: STATE.LIMITED },

                // T3: init → unlimitedAutonomous
                { name: 'initTimeout', from: STATE.INIT, to: STATE.UNLIMITED_AUTONOMOUS },

                // T4: unlimitedControlled → limited
                { name: 'heartbeatActivatedLimit', from: STATE.UNLIMITED_CONTROLLED, to: STATE.LIMITED },

                // T5: unlimitedControlled → failsafe
                { name: 'heartbeatTimeout', from: STATE.UNLIMITED_CONTROLLED, to: STATE.FAILSAFE },

                // T6: limited → unlimitedControlled
                { name: 'limitDurationExpired', from: STATE.LIMITED, to: STATE.UNLIMITED_CONTROLLED },
                { name: 'heartbeatDeactivatedLimit', from: STATE.LIMITED, to: STATE.UNLIMITED_CONTROLLED },
                { name: 'heartbeatLimitNotApplicable', from: STATE.LIMITED, to: STATE.UNLIMITED_CONTROLLED },

                // T7: limited → failsafe
                { name: 'heartbeatTimeout', from: STATE.LIMITED, to: STATE.FAILSAFE },

                // T8: failsafe → unlimitedControlled
                { name: 'heartbeatDeactivatedLimit', from: STATE.FAILSAFE, to: STATE.UNLIMITED_CONTROLLED },
                { name: 'heartbeatLimitNotApplicable', from: STATE.FAILSAFE, to: STATE.UNLIMITED_CONTROLLED },

                // T9: failsafe → limited
                { name: 'heartbeatActivatedLimit', from: STATE.FAILSAFE, to: STATE.LIMITED },

                // T10: failsafe → unlimitedAutonomous
                { name: 'failsafeDurationExpired', from: STATE.FAILSAFE, to: STATE.UNLIMITED_AUTONOMOUS },
                { name: 'heartbeatNoFollowingLimit', from: STATE.FAILSAFE, to: STATE.UNLIMITED_AUTONOMOUS },

                // T11: unlimitedAutonomous → unlimitedControlled
                { name: 'heartbeatDeactivatedLimit', from: STATE.UNLIMITED_AUTONOMOUS, to: STATE.UNLIMITED_CONTROLLED },
                {
                    name: 'heartbeatLimitNotApplicable',
                    from: STATE.UNLIMITED_AUTONOMOUS,
                    to: STATE.UNLIMITED_CONTROLLED,
                },

                // T12: unlimitedAutonomous → limited
                { name: 'heartbeatActivatedLimit', from: STATE.UNLIMITED_AUTONOMOUS, to: STATE.LIMITED },

                // T0: any → init (restart)
                { name: 'restart', from: '*', to: STATE.INIT },
            ],
            methods: {
                onRestart: () => {
                    this.#onRestart();
                },
                onEnterState: lifecycle => {
                    this.#onEnterState(lifecycle);
                },
                onLeaveState: lifecycle => {
                    this.#onLeaveState(lifecycle);
                },
            },
        });
    }

    /**
     * Called when the FSM enters a new state.
     * Starts timers for init and failsafe states.
     *
     * @param {object} lifecycle - { transition, from, to }
     */
    #onEnterState(lifecycle) {
        const log = this.#adapter.log;
        log.debug(`FSM enter: ${lifecycle.from} → ${lifecycle.to} (${lifecycle.transition})`);

        this.#adapter.setState('info.state', lifecycle.to, true);

        if (lifecycle.to === STATE.INIT) {
            // T3: if no heartbeat + limit within 120s → unlimitedAutonomous
            this.#startInitTimer();
        } else if (lifecycle.to === STATE.FAILSAFE) {
            // T10: after failsafe duration minimum expires → unlimitedAutonomous
            this.#startFailsafeTimer();
        }
    }

    /**
     * Called when the FSM leaves a state.
     * Clears timers that are no longer relevant.
     *
     * @param {object} lifecycle - { transition, from, to }
     */
    #onLeaveState(lifecycle) {
        if (lifecycle.from === STATE.INIT) {
            this.#clearInitTimer();
        } else if (lifecycle.from === STATE.FAILSAFE) {
            this.#clearFailsafeTimer();
            this.#clearFailsafeHeartbeatTimer();
        } else if (lifecycle.from === STATE.LIMITED) {
            this.#clearLimitDurationTimer();
        }
    }

    /**
     * Start the init timeout timer (120s).
     * T3: init → unlimitedAutonomous if no heartbeat + limit received.
     */
    #startInitTimer() {
        this.#clearInitTimer();
        const log = this.#adapter.log;
        this.#initTimer = setTimeout(() => {
            if (this.#can('initTimeout')) {
                log.warn('Init timeout (120s) — no heartbeat/limit received, entering unlimitedAutonomous');
                this.#initTimeout();
            }
        }, 120_000);
    }

    /**
     * Clear the init timeout timer.
     */
    #clearInitTimer() {
        if (this.#initTimer) {
            clearTimeout(this.#initTimer);
            this.#initTimer = null;
        }
    }

    /**
     * Start the failsafe duration timer.
     * T10: failsafe → unlimitedAutonomous after failsafe duration minimum expires.
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

        log.info(`Failsafe timer started: ${durationMs}ms`);
        this.#failsafeTimer = setTimeout(() => {
            if (this.#can('failsafeDurationExpired')) {
                log.warn('Failsafe duration expired — entering unlimitedAutonomous');
                this.#failsafeDurationExpired();
            }
        }, durationMs);
    }

    /**
     * Clear the failsafe duration timer.
     */
    #clearFailsafeTimer() {
        if (this.#failsafeTimer) {
            clearTimeout(this.#failsafeTimer);
            this.#failsafeTimer = null;
        }
    }

    /**
     * Internal handler called when the FSM transitions to init via restart.
     * Sets up the control client, configures the service, registers the use case,
     * configures the CS LPC client with limits, and starts the service.
     */
    async #onRestart() {
        const config = this.#config;
        const log = this.#adapter.log;

        if (!config.grpcEndpoint) {
            log.error('grpcEndpoint is not configured — skipping restart');
            return;
        }

        // Clear any pending retry
        if (this.#retryTimer) {
            clearTimeout(this.#retryTimer);
            this.#retryTimer = null;
        }

        // Reset all EEBUS guards to clean state before reconnecting
        for (const guard of this.#energyGuards) {
            if (guard instanceof EebusEnergyGuard) {
                await guard.unassignUseCaseClient();
            }
        }

        try {
            await this.#connect();
        } catch (err) {
            log.warn(`gRPC connection failed: ${err.message} — retrying in 10s`);
            this.#adapter.setState('info.connection', false, true);
            this.#retryTimer = setTimeout(() => this.#onRestart(), 10_000);
        }
    }

    /**
     * Perform the actual gRPC setup sequence.
     * Separated from #onRestart so retry logic stays clean.
     */
    async #connect() {
        const config = this.#config;
        const log = this.#adapter.log;

        // Create control client
        this.#controlClient = makeClient({
            protoDir: PROTO_DIR,
            protoRelPath: 'control_service/control_service.proto',
            pkg: 'control_service',
            service: 'ControlService',
            endpoint: config.grpcEndpoint,
        });

        // Reset and configure service
        await resetService(this.#controlClient);
        await setConfig(this.#controlClient, {
            SERVICE_PORT: config.servicePort,
            VENDOR_CODE: 'iobroker',
            DEVICE_BRAND: 'iobroker',
            DEVICE_MODEL: 'HEMS',
            SERIAL_NUMBER: config.serialNumber,
            DEVICE_CATEGORIES: 'ENERGY_MANAGEMENT_SYSTEM',
            DEVICE_TYPE: 'ENERGY_MANAGEMENT_SYSTEM',
            ENTITY_TYPES: 'CEM',
            HEARTBEAT_TIMEOUT_SECONDS: config.heartbeatTimeoutSeconds,
        });
        await startSetup(this.#controlClient);

        // Add CS-LPC UseCase → get endpoint
        const cemAddr = [1];
        const cemLpcEndpoint = await addCsLpcUseCase(this.#controlClient, cemAddr);
        if (!cemLpcEndpoint) {
            throw new Error('AddUseCase returned empty endpoint');
        }
        log.info(`CS-LPC UseCase added with endpoint: ${cemLpcEndpoint}`);

        // Create CS-LPC client at the UseCase endpoint
        this.#csLpcClient = makeClient({
            protoDir: PROTO_DIR,
            protoRelPath: 'usecases/cs/lpc/service.proto',
            pkg: 'cs_lpc',
            service: 'ControllableSystemLPCControl',
            endpoint: cemLpcEndpoint,
        });

        // Configure consumption limits
        await callUnary(this.#csLpcClient, 'SetConsumptionNominalMax', { value: 32000 });
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

        // Register remote SKI and start service
        if (config.controlboxSki && config.controlboxSki.length >= 40) {
            await registerRemoteSki(this.#controlClient, config.controlboxSki);
        }
        await startService(this.#controlClient);

        // Initialize Energy Guards from config
        await this.#initEnergyGuards();

        // Subscribe to discovery events
        this.#subscribeDiscoveryEvents();

        // Subscribe to CS-LPC use case events
        this.#subscribeCsLpcEvents();

        log.info('HEMS connected and running');
        this.#adapter.setState('info.connection', true, true);
    }

    /**
     * Initialize Energy Guards from adapter configuration.
     * Creates guard instances, the top-level folder, and each guard's object tree.
     * Registers EG-LPC use cases and trusts SKIs for EEBUS guards.
     * Detects and skips duplicate SKIs.
     */
    async #initEnergyGuards() {
        const config = this.#config;
        const log = this.#adapter.log;
        const guardConfigs = config.energyGuards || [];

        if (guardConfigs.length === 0) {
            return;
        }

        const seenSkis = new Set();
        this.#energyGuards = [];
        this.#egLpcEndpoints.clear();

        let eebusIndex = 0;

        for (const entry of guardConfigs) {
            if (entry.type === 'eebus') {
                // Check for duplicate SKI
                if (seenSkis.has(entry.ski)) {
                    log.error(`Duplicate SKI detected for energy guard "${entry.name}" — skipping`);
                    continue;
                }
                seenSkis.add(entry.ski);

                const guard = new EebusEnergyGuard(this.#adapter, entry.name, entry.ski);
                await guard.createObjects();
                this.#energyGuards.push(guard);

                // Register EG-LPC use case for this EEBUS guard
                eebusIndex++;
                try {
                    const entityAddr = [1, eebusIndex];
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
                        log.error(`AddUseCase returned empty endpoint for guard "${entry.name}" — skipping EG-LPC`);
                    }
                } catch (err) {
                    log.error(`Failed to add EG-LPC use case for guard "${entry.name}": ${err.message}`);
                }

                // Register the guard's SKI as trusted
                try {
                    await registerRemoteSki(this.#controlClient, entry.ski);
                    log.info(`Registered remote SKI for guard "${entry.name}": ${entry.ski}`);
                } catch (err) {
                    log.error(`Failed to register remote SKI for guard "${entry.name}": ${err.message}`);
                }
            } else if (entry.type === 'manual') {
                const guard = new ManualEnergyGuard(this.#adapter, entry.name);
                await guard.createObjects();
                this.#energyGuards.push(guard);
            } else {
                log.warn(`Unknown energy guard type "${entry.type}" for guard "${entry.name}" — skipping`);
            }
        }

        // Subscribe to EG-LPC use case events for pairing
        if (this.#egLpcEndpoints.size > 0) {
            this.#subscribeEgLpcEvents();
        }

        log.info(`Initialized ${this.#energyGuards.length} energy guard(s)`);
    }

    /**
     * Distribute a consumption limit to all energy guards.
     * If inactive, deactivates all guards. If any guard is not connected,
     * falls back to applying each guard's failsafe limit. Otherwise,
     * reads percentages, applies proportional scaling if sum > 100%,
     * and sends effective limits to each guard.
     *
     * @param {boolean} isActive - Whether the limit is active
     */
    async #distributeLimit(isActive) {
        this.#lastLimitActive = isActive;

        const contractMax = this.#consumptionNominalMax;

        if (!isActive) {
            for (const guard of this.#energyGuards) {
                try {
                    await guard.deactivateLimit();
                } catch (err) {
                    this.#adapter.log.warn(`Failed to deactivate limit on guard "${guard.name}": ${err.message}`);
                }
            }
            return;
        }

        // Check if all guards are connected
        const allConnected = this.#energyGuards.every(g => g.isConnected());

        if (!allConnected) {
            // Fallback: apply each guard's own failsafe limit (effectivePct=0 means floor applies)
            for (const guard of this.#energyGuards) {
                try {
                    await guard.applyLimit(contractMax, 0);
                } catch (err) {
                    this.#adapter.log.warn(`Failed to apply fallback limit to guard "${guard.name}": ${err.message}`);
                }
            }
            return;
        }

        // Read all percentages from ioBroker state objects
        const percentages = await Promise.all(this.#energyGuards.map(g => g.getPercentage()));
        const sum = percentages.reduce((acc, p) => acc + p, 0);

        // If sum > 100%, scale proportionally
        const scale = sum > 100 ? 100 / sum : 1;

        if (scale < 1) {
            this.#adapter.log.info(
                `Percentage sum ${sum}% exceeds 100% — scaling down by factor ${scale.toFixed(4)}: ` +
                    `original=[${percentages.join(', ')}], ` +
                    `scaled=[${percentages.map(p => (p * scale).toFixed(2)).join(', ')}]`,
            );
        }

        for (let i = 0; i < this.#energyGuards.length; i++) {
            const effectivePct = percentages[i] * scale;
            try {
                await this.#energyGuards[i].applyLimit(contractMax, effectivePct);
            } catch (err) {
                this.#adapter.log.warn(
                    `Failed to apply limit to guard "${this.#energyGuards[i].name}": ${err.message}`,
                );
            }
        }
    }

    /**
     * Subscribe to SubscribeUseCaseEvents for EG-LPC use cases.
     * Handles all events: pairing (UseCaseSupportUpdate), heartbeat, and others.
     * Creates the EG-LPC control client only once on UseCaseSupportUpdate (pairing).
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
                log.debug(`EG-LPC event for entity [${entityAddr}]: remote_ski=${remoteSki}, event=${eventName}`);

                // Match incoming remote_ski to the guard with this SKI
                if (remoteSki !== ski) {
                    return;
                }

                const guard = this.#energyGuards.find(g => g instanceof EebusEnergyGuard && g.ski === ski);
                if (!guard) {
                    return;
                }

                if (eventName === 'UseCaseSupportUpdate') {
                    // Pairing event — create EG-LPC control client at the stored endpoint (only if not already created)
                    if (!guard.egLpcClient) {
                        const egLpcClient = makeClient({
                            protoDir: PROTO_DIR,
                            protoRelPath: 'usecases/eg/lpc/service.proto',
                            pkg: 'eg_lpc',
                            service: 'EnergyGuardLPCControl',
                            endpoint,
                        });
                        guard.assignUseCaseClient(egLpcClient);
                        log.info(`EG-LPC client assigned to guard "${guard.name}" (SKI=${ski})`);
                    }
                } else if (eventName === 'DataUpdateHeartbeat') {
                    // Heartbeat event from the paired EG-LPC device
                    try {
                        await guard.handleHeartbeat();
                        log.debug(`Heartbeat received for guard "${guard.name}" (SKI=${ski})`);
                    } catch (err) {
                        log.warn(`Failed to handle heartbeat for guard "${guard.name}": ${err.message}`);
                    }

                    // If a limit is currently active, re-run distribution
                    // (this guard may have been the one preventing full distribution)
                    if (this.#lastLimitActive) {
                        try {
                            await this.#distributeLimit(true);
                        } catch (err) {
                            log.warn(`Failed to re-distribute limit after heartbeat: ${err.message}`);
                        }
                    }
                } else if (eventName === 'DataUpdateFailsafeConsumptionActivePowerLimit') {
                    // Failsafe limit update from the remote device — read via RPC
                    try {
                        const res = await callUnary(guard.egLpcClient, 'FailsafeConsumptionActivePowerLimit', {
                            remote_ski: ski,
                            remote_entity_address: { entity_address: entityAddr },
                        });
                        const failsafeValue = res.limit || 0;
                        await guard.setFailsafeLimit(failsafeValue);
                        log.info(`Failsafe limit updated for guard "${guard.name}": ${failsafeValue}W`);

                        // Re-distribute if limit is active (floor may have changed)
                        if (this.#lastLimitActive) {
                            await this.#distributeLimit(true);
                        }
                    } catch (err) {
                        log.warn(`Failed to read failsafe limit for guard "${guard.name}": ${err.message}`);
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

    /**
     * Subscribe to SubscribeDiscoveryEvents on the control client.
     * Maintains #discoveredDevices keyed by remote_ski.
     */
    #subscribeDiscoveryEvents() {
        const log = this.#adapter.log;

        if (this.#discoveryStream) {
            this.#discoveryStream.cancel();
        }

        this.#discoveredDevices.clear();
        this.#discoveryStream = this.#controlClient.SubscribeDiscoveryEvents({});

        this.#discoveryStream.on('data', event => {
            const ski = event.remote_ski;
            if (event.type === 'DISCOVERED') {
                this.#discoveredDevices.set(ski, {
                    remoteSki: ski,
                    shipIdentifier: event.ship_identifier,
                    brand: event.brand,
                    model: event.model,
                    deviceType: event.device_type,
                    serial: event.serial,
                    isTrusted: event.is_trusted,
                });
                log.debug(`Discovery: device appeared — SKI=${ski}`);
            } else if (event.type === 'REMOVED') {
                this.#discoveredDevices.delete(ski);
                log.debug(`Discovery: device removed — SKI=${ski}`);
            }
            this.#persistDiscoveredDevices();
        });

        this.#discoveryStream.on('error', err => {
            log.error(`Discovery stream error: ${err.message}`);
            this.#scheduleReconnect();
        });

        this.#discoveryStream.on('end', () => {
            log.warn('Discovery stream ended');
            this.#scheduleReconnect();
        });
    }

    /**
     * Persist the current discovered devices map into the adapter's native config.
     * This stores it as JSON in io-package native so it survives restarts.
     */
    #persistDiscoveredDevices() {
        const devices = Object.fromEntries(this.#discoveredDevices);
        this.#adapter.extendForeignObject(`system.adapter.${this.#adapter.namespace}`, {
            native: { discoveredDevices: devices },
        });
    }

    /**
     * Schedule a reconnect attempt after the gRPC server connection is lost.
     * Waits 10s then triggers a full restart of the HEMS setup.
     */
    #scheduleReconnect() {
        if (this.#retryTimer) {
            return; // already scheduled
        }
        const log = this.#adapter.log;
        log.warn('gRPC connection lost — scheduling reconnect in 10s');
        this.#adapter.setState('info.connection', false, true);
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            this.restart();
        }, 10_000);
    }

    /**
     * Subscribe to CS-LPC use case events and handle them.
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
                // Update of the list of remote entities supporting the Use Case
                log.debug('UseCaseSupportUpdate — no action needed');
            } else if (eventName === 'DataUpdateLimit') {
                // Load control obligation limit data update received (Scenario 1)
                await this.#handleDataUpdateLimit();
            } else if (eventName === 'WriteApprovalRequired') {
                // An incoming load control obligation limit needs to be approved or denied (Scenario 1)
                await this.#approvePendingLimits();
            } else if (eventName === 'DataUpdateFailsafeConsumptionActivePowerLimit') {
                // Failsafe limit for consumed active power data update received (Scenario 2)
                await this.#handleDataUpdateFailsafeLimit();
            } else if (eventName === 'DataUpdateFailsafeDurationMinimum') {
                // Minimum time the CS remains in failsafe state data update received (Scenario 2)
                await this.#handleDataUpdateFailsafeDuration();
            } else if (eventName === 'DataUpdateHeartbeat') {
                // Heartbeat event — CS may go into or out of failsafe state (Scenario 3)
                await this.#handleDataUpdateHeartbeat();
            } else {
                log.warn(`Unknown CS-LPC event: ${eventName}`);
            }
        });
    }

    /**
     * Approve or deny pending consumption limits based on the configured minimum threshold.
     * Only approves limits where value >= native config parameter `minApprovalLimit`.
     * Use Case LPC, Scenario 1
     */
    async #approvePendingLimits() {
        const log = this.#adapter.log;
        const minLimit = Number(this.#config.minApprovalLimit) || 0;
        const res = await callUnary(this.#csLpcClient, 'PendingConsumptionLimit', {});
        const pending = res.load_limits || {};

        for (const [msgCounter, loadLimit] of Object.entries(pending)) {
            const value = loadLimit.value || 0;
            const approve = value >= minLimit;

            if (approve) {
                log.info(`Approving pending limit msgCounter=${msgCounter}, value=${value} (>= ${minLimit})`);
            } else {
                log.warn(`Denying pending limit msgCounter=${msgCounter}, value=${value} (< ${minLimit})`);
            }

            await callUnary(this.#csLpcClient, 'ApproveOrDenyConsumptionLimit', {
                msg_counter: Number(msgCounter),
                approve,
                reason: approve ? '' : `Limit ${value} below minimum ${minLimit}`,
            });

            if (!approve && this.#can('heartbeatLimitNotApplicable')) {
                this.#heartbeatLimitNotApplicable();
                log.info(`FSM transition: heartbeatLimitNotApplicable → ${this.state}`);
            }
        }
    }

    /**
     * Handle DataUpdateLimit: read current consumption limit and trigger FSM transitions.
     * Use Case LPC, Scenario 1
     *
     * Transitions:
     *  - limit active + applicable → heartbeatActivatedLimit (T2, T4, T9, T12)
     *  - limit deactivated → heartbeatDeactivatedLimit (T1, T6, T8, T11)
     */
    async #handleDataUpdateLimit() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLpcClient, 'ConsumptionLimit', {});
        const limit = res.load_limit || {};
        log.info(`Consumption limit update: active=${limit.is_active}, value=${limit.value}`);

        // A limit write arrived — cancel the "no following limit" timer if running
        this.#clearFailsafeHeartbeatTimer();

        if (limit.is_active) {
            if (this.#can('heartbeatActivatedLimit')) {
                this.#heartbeatActivatedLimit();
                log.info(`FSM transition: heartbeatActivatedLimit → ${this.state}`);
            }
            // Start duration timer if limit has a finite duration (T6)
            this.#startLimitDurationTimer(limit.duration_nanoseconds);
        } else {
            if (this.#can('heartbeatDeactivatedLimit')) {
                this.#heartbeatDeactivatedLimit();
                log.info(`FSM transition: heartbeatDeactivatedLimit → ${this.state}`);
            }
        }

        // Distribute limit to all Energy Guards
        await this.#distributeLimit(!!limit.is_active);
    }

    /**
     * Handle DataUpdateFailsafeConsumptionActivePowerLimit: read current failsafe limit.
     * Use Case LPC, Scenario 2
     */
    async #handleDataUpdateFailsafeLimit() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLpcClient, 'FailsafeConsumptionActivePowerLimit', {});
        log.info(`Failsafe consumption limit update: value=${res.limit}, changeable=${res.is_changeable}`);
    }

    /**
     * Handle DataUpdateFailsafeDurationMinimum: read current failsafe duration.
     * Use Case LPC, Scenario 2
     */
    async #handleDataUpdateFailsafeDuration() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLpcClient, 'FailsafeDurationMinimum', {});
        log.info(`Failsafe duration minimum update: ${res.duration_nanoseconds}ns, changeable=${res.is_changeable}`);
    }

    /**
     * Handle DataUpdateHeartbeat: heartbeat event indicating CS may enter or leave failsafe.
     * Use Case LPC, Scenario 3
     *
     * Transitions:
     *  - heartbeat NOT within duration → heartbeatTimeout (T5, T7)
     *    Moves unlimitedControlled/limited → failsafe
     *  - heartbeat received while in failsafe → starts 120s timer for T10
     *    (heartbeatNoFollowingLimit if no limit write arrives)
     */
    async #handleDataUpdateHeartbeat() {
        const log = this.#adapter.log;
        const res = await callUnary(this.#csLpcClient, 'IsHeartbeatWithinDuration', {});
        log.info(`Heartbeat update: withinDuration=${res.is_within_duration}`);

        if (!res.is_within_duration) {
            if (this.#can('heartbeatTimeout')) {
                this.#heartbeatTimeout();
                log.warn(`FSM transition: heartbeatTimeout → ${this.state}`);
            }
        } else if (this.state === STATE.FAILSAFE) {
            // Heartbeat received in failsafe — if no limit write within 120s → unlimitedAutonomous
            this.#startFailsafeHeartbeatTimer();
        }
    }

    /**
     * Start a 120s timer after receiving heartbeat in failsafe.
     * T10 alternate: if no following limit write arrives within 120s → unlimitedAutonomous.
     */
    #startFailsafeHeartbeatTimer() {
        this.#clearFailsafeHeartbeatTimer();
        const log = this.#adapter.log;
        this.#failsafeHeartbeatTimer = setTimeout(() => {
            if (this.#can('heartbeatNoFollowingLimit')) {
                log.warn('No limit received within 120s after heartbeat in failsafe — entering unlimitedAutonomous');
                this.#heartbeatNoFollowingLimit();
            }
        }, 120_000);
    }

    /**
     * Clear the failsafe heartbeat timer (cancelled when a limit write is received).
     */
    #clearFailsafeHeartbeatTimer() {
        if (this.#failsafeHeartbeatTimer) {
            clearTimeout(this.#failsafeHeartbeatTimer);
            this.#failsafeHeartbeatTimer = null;
        }
    }

    /**
     * Start the limit duration timer.
     * T6: limited → unlimitedControlled when the activated limit's duration expires.
     *
     * @param {number} durationNs - Duration in nanoseconds from the LoadLimit message
     */
    #startLimitDurationTimer(durationNs) {
        this.#clearLimitDurationTimer();
        if (!durationNs || durationNs <= 0) {
            return; // no duration set — limit is indefinite until explicitly deactivated
        }
        const log = this.#adapter.log;
        const durationMs = Number(durationNs) / 1_000_000;
        log.info(`Limit duration timer started: ${durationMs}ms`);
        this.#limitDurationTimer = setTimeout(() => {
            if (this.#can('limitDurationExpired')) {
                log.info('Limit duration expired — entering unlimitedControlled');
                this.#limitDurationExpired();
            }
        }, durationMs);
    }

    /**
     * Clear the limit duration timer.
     */
    #clearLimitDurationTimer() {
        if (this.#limitDurationTimer) {
            clearTimeout(this.#limitDurationTimer);
            this.#limitDurationTimer = null;
        }
    }

    /**
     * Current state of the state machine.
     *
     * @returns {string} One of the STATE constants
     */
    get state() {
        return this.#fsm.state;
    }

    /**
     * Check whether a transition is possible from the current state.
     *
     * @param {string} transition - Transition name
     * @returns {boolean} true if the transition can fire
     */
    #can(transition) {
        return this.#fsm.can(transition);
    }

    /**
     * Trigger: Heartbeat received with a deactivated power limit.
     * Valid from: init, limited, failsafe, unlimitedAutonomous → unlimitedControlled
     */
    #heartbeatDeactivatedLimit() {
        this.#fsm.heartbeatDeactivatedLimit();
    }

    /**
     * Trigger: Heartbeat received with an activated limit that cannot be applied.
     * Valid from: init, limited, failsafe, unlimitedAutonomous → unlimitedControlled
     */
    #heartbeatLimitNotApplicable() {
        this.#fsm.heartbeatLimitNotApplicable();
    }

    /**
     * Trigger: Heartbeat received with an activated limit that can be applied.
     * Valid from: init, unlimitedControlled, failsafe, unlimitedAutonomous → limited
     */
    #heartbeatActivatedLimit() {
        this.#fsm.heartbeatActivatedLimit();
    }

    /**
     * Trigger: No heartbeat/limit received within 120s after init.
     * Valid from: init → unlimitedAutonomous
     */
    #initTimeout() {
        this.#fsm.initTimeout();
    }

    /**
     * Trigger: No heartbeat received within 120s since last heartbeat.
     * Valid from: unlimitedControlled, limited → failsafe
     */
    #heartbeatTimeout() {
        this.#fsm.heartbeatTimeout();
    }

    /**
     * Trigger: Duration of activated power limit expired.
     * Valid from: limited → unlimitedControlled
     */
    #limitDurationExpired() {
        this.#fsm.limitDurationExpired();
    }

    /**
     * Trigger: Failsafe duration minimum expired.
     * Valid from: failsafe → unlimitedAutonomous
     */
    #failsafeDurationExpired() {
        this.#fsm.failsafeDurationExpired();
    }

    /**
     * Trigger: Heartbeat received but no following limit within 120s.
     * Valid from: failsafe → unlimitedAutonomous
     */
    #heartbeatNoFollowingLimit() {
        this.#fsm.heartbeatNoFollowingLimit();
    }

    /**
     * Trigger: Restart of CS completed. Resets to init state.
     * Valid from: any state → init
     */
    restart() {
        this.#fsm.restart();
    }

    /**
     * Handle state changes for Energy Guard states.
     * Called from main.js onStateChange for states under EnergyGuards.*.
     *
     * Handles:
     * - percentage changes: re-distributes limit if active
     * - heartbeat writes on manual guards: calls onHeartbeatWrite()
     * - connected writes on manual guards: calls onConnectedWrite(value) and re-distributes if limit active
     *
     * @param {string} id - Full state ID (e.g., "eebus-go.0.EnergyGuards.Guard_WallBox.percentage")
     * @param {ioBroker.State} state - State object (only ack=false writes are forwarded here)
     */
    async handleEnergyGuardStateChange(id, state) {
        const log = this.#adapter.log;

        // Extract the part after "EnergyGuards." from the local ID
        // id is full: "eebus-go.0.EnergyGuards.Guard_Name.stateName"
        // We need to strip the adapter namespace prefix to get the local part
        const namespace = this.#adapter.namespace;
        const localId = id.startsWith(`${namespace}.`) ? id.slice(namespace.length + 1) : id;

        // localId is now "EnergyGuards.Guard_Name.stateName"
        const parts = localId.split('.');
        // parts: ["EnergyGuards", "Guard_Name", "stateName"]
        if (parts.length < 3) {
            return;
        }

        const guardFolder = parts[1]; // "Guard_Name"
        const stateName = parts[2]; // "percentage", "heartbeat", "connected"

        // Extract the guard name from the folder name (strip "Guard_" prefix)
        if (!guardFolder.startsWith('Guard_')) {
            return;
        }
        const guardName = guardFolder.slice('Guard_'.length);

        // Find the matching guard
        const guard = this.#energyGuards.find(g => g.name === guardName);
        if (!guard) {
            log.debug(`No energy guard found for name "${guardName}" — ignoring state change`);
            return;
        }

        if (stateName === 'percentage') {
            // Percentage changed on ANY guard type: re-distribute if limit active
            log.info(`Energy guard "${guardName}" percentage changed to ${state.val}`);
            if (this.#lastLimitActive) {
                await this.#distributeLimit(true);
            }
        } else if (stateName === 'heartbeat') {
            // Heartbeat write: only applies to ManualEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`Manual energy guard "${guardName}" heartbeat write received`);
                await guard.onHeartbeatWrite();
            }
        } else if (stateName === 'connected') {
            // Connected write: only applies to ManualEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`Manual energy guard "${guardName}" connected changed to ${state.val}`);
                await guard.onConnectedWrite(state.val);
                // Connection state affects limit distribution for all guards
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        } else if (stateName === 'failsafeLimit') {
            // Failsafe limit write: only applies to ManualEnergyGuard
            if (guard instanceof ManualEnergyGuard) {
                log.info(`Manual energy guard "${guardName}" failsafeLimit changed to ${state.val}`);
                await guard.onFailsafeLimitWrite(state.val);
                // Failsafe limit change affects distribution if limit is active
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        }
    }
}

module.exports = { Hems, STATE };
