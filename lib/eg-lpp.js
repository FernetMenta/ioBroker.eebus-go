'use strict';

const path = require('node:path');
const { makeClient, callUnary, isTransportError, getEndpoint } = require('./grpc-client');
const { EebusEnergyGuard, ManualEnergyGuard } = require('./energy-guard');
const { registerRemoteSki } = require('./grpc-service');

/**
 * Root directory for protobuf definitions.
 */
const PROTO_DIR = path.join(__dirname, 'protobuf');

/**
 * EG-LPP: Energy Guard management for Limitation of Power Production.
 *
 * Responsibilities:
 *  - Initialize and manage LPP energy guards (EEBUS + manual)
 *  - Subscribe to EG-LPP gRPC events (pairing, heartbeat, failsafe, limit confirmation)
 *  - Distribute production limits to guards
 *  - Report failsafe sum to the controlbox (via CS-LPP client)
 *  - Handle guard state changes (percentage, heartbeat, connected, failsafeLimit, manualLimit)
 *  - Manage manual limit timers
 *  - Track control box connection state for manual limit gating
 *
 * This class is owned by Hems and does NOT know about the FSM or CS-LPP events.
 * It receives limit updates via distributeLimit() called by Hems.
 */
class EgLpp {
    #adapter;
    #config;
    #controlClient;
    #csLppClient;
    #csLppInstanceId;
    #translate;
    #onGrpcError;
    #guards;
    #egLppEndpoints;
    #lpcEntityMap;
    #egLppStreams;
    #lastLimitActive;
    #currentLimitValue;
    #currentLimitDurationNs;
    #limitReceivedAt;
    #controlBoxConnected;
    #manualLimitTimers;
    #stopped;

    /**
     * Create a new EgLpp instance.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {object} config - Adapter configuration (native object)
     * @param {object} controlClient - gRPC ControlService client (shared)
     * @param {object} csLppClient - CS-LPP gRPC client (for SetFailsafeProductionActivePowerLimit)
     * @param {string} csLppInstanceId - CS-LPP instance ID for routing
     * @param {(key: string) => string} translate - I18n translate function
     * @param {object} [callbacks] - Optional callback functions
     * @param {() => void} [callbacks.onGrpcError] - Called when a gRPC call fails (triggers reconnect)
     */
    constructor(adapter, config, controlClient, csLppClient, csLppInstanceId, translate, { onGrpcError } = {}) {
        this.#adapter = adapter;
        this.#config = config;
        this.#controlClient = controlClient;
        this.#csLppClient = csLppClient;
        this.#csLppInstanceId = csLppInstanceId;
        this.#translate = translate || (key => key);
        this.#onGrpcError = onGrpcError || (() => {});
        this.#guards = [];
        this.#egLppEndpoints = new Map();
        this.#lpcEntityMap = new Map();
        this.#egLppStreams = [];
        this.#lastLimitActive = false;
        this.#currentLimitValue = 0;
        this.#currentLimitDurationNs = 0;
        this.#limitReceivedAt = null;
        this.#controlBoxConnected = false;
        this.#manualLimitTimers = new Map();
        this.#stopped = false;
    }

    // ─── Public Interface ────────────────────────────────────────────────

    /**
     * Get the array of failsafe limit values for all configured guards.
     *
     * @returns {number[]} Array of failsafe limit values (watts)
     */
    getGuardFailsafeLimits() {
        return this.#guards.map(g => g.failsafeLimit || 0);
    }

    /**
     * Start the energy guard initialization phase.
     * Registers EG-LPP use cases on pre-created entities, subscribes to EG events.
     *
     * @param {Map<string, number[]>} egEntityMap - Map of SKI → entity address (created by Hems)
     */
    async start(egEntityMap) {
        this.#lpcEntityMap = egEntityMap || new Map();
        await this.#initEnergyGuards();
    }

    /**
     * Stop and clean up all EG-LPP resources.
     */
    stop() {
        this.#stopped = true;
        for (const timer of this.#manualLimitTimers.values()) {
            this.#adapter.clearTimeout(timer);
        }
        this.#manualLimitTimers.clear();
        for (const stream of this.#egLppStreams) {
            try {
                stream.cancel();
            } catch {
                // ignore
            }
        }
        this.#egLppStreams = [];
        for (const guard of this.#guards) {
            if (guard instanceof EebusEnergyGuard && guard.egLpcClient) {
                guard.egLpcClient.close();
            }
        }
    }

    /**
     * Distribute a production limit to all energy guards.
     * Called by Hems when the CS-LPP reports a limit update.
     *
     * @param {boolean} isActive - Whether the limit is active
     * @param {number} limitValue - The limit value in watts (0 if deactivated)
     * @param {number} [durationNs] - Original limit duration in nanoseconds (0 = indefinite)
     */
    async distributeLimit(isActive, limitValue, durationNs = 0) {
        this.#currentLimitValue = limitValue;
        this.#currentLimitDurationNs = durationNs;
        this.#limitReceivedAt = durationNs > 0 ? Date.now() : null;
        try {
            await this.#distributeLimit(isActive);
        } catch (err) {
            if (isTransportError(err)) {
                this.#adapter.log.error(
                    `LPP distributeLimit gRPC transport error: ${err.message} — triggering reconnect`,
                );
                this.#onGrpcError();
            } else {
                this.#adapter.log.warn(`LPP distributeLimit error: ${err.message}`);
            }
        }
    }

    /**
     * Update the control box connection state.
     * When the control box connects, reset any active manual limits on EEBUS guards.
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
            try {
                const eebusGuards = this.#guards.filter(g => g instanceof EebusEnergyGuard);
                await resetManualLimits(eebusGuards, this.#adapter, this.#manualLimitTimers, callUnary);
            } catch (err) {
                if (isTransportError(err)) {
                    log.error(`LPP setControlBoxConnected gRPC transport error: ${err.message} — triggering reconnect`);
                    this.#onGrpcError();
                } else {
                    log.warn(`LPP setControlBoxConnected error: ${err.message}`);
                }
            }
        }
    }

    /**
     * Handle state changes for LPP Energy Guard states.
     *
     * @param {string} localId - Local state ID (e.g., "LPP.EnergyGuards.Guard_Inverter.percentage")
     * @param {ioBroker.State} state - State object (only ack=false writes are forwarded here)
     */
    async handleGuardStateChange(localId, state) {
        try {
            await this.#handleGuardStateChange(localId, state);
        } catch (err) {
            if (isTransportError(err)) {
                this.#adapter.log.error(
                    `LPP handleGuardStateChange gRPC transport error: ${err.message} — triggering reconnect`,
                );
                this.#onGrpcError();
            } else {
                this.#adapter.log.warn(`LPP handleGuardStateChange error: ${err.message}`);
            }
        }
    }

    async #handleGuardStateChange(localId, state) {
        const log = this.#adapter.log;
        log.debug(`LPP handleGuardStateChange: ${localId} = ${state.val}`);

        const parts = localId.split('.');
        if (parts[0] !== 'LPP' || parts.length < 4) {
            return;
        }
        const guardFolder = parts[2];
        const stateName = parts[3];

        if (!guardFolder.startsWith('Guard_')) {
            return;
        }
        const guardName = guardFolder.slice('Guard_'.length);

        const guard = this.#guards.find(g => g.name === guardName);
        if (!guard) {
            log.debug(`No LPP energy guard found for name "${guardName}" — ignoring state change`);
            return;
        }

        if (stateName === 'percentage') {
            log.info(`LPP energy guard "${guardName}" percentage changed to ${state.val}`);
            await this.#adapter.setStateAsync(`${guard.basePath}.percentage`, state.val, true);
            if (this.#lastLimitActive) {
                await this.#distributeLimit(true);
            }
        } else if (stateName === 'heartbeat') {
            if (guard instanceof ManualEnergyGuard) {
                log.debug(`LPP manual energy guard "${guardName}" heartbeat write received`);
                await guard.onHeartbeatWrite();
            }
        } else if (stateName === 'connected') {
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPP manual energy guard "${guardName}" connected changed to ${state.val}`);
                await guard.onConnectedWrite(state.val);
            }
        } else if (stateName === 'failsafeLimit') {
            const newValue = Math.max(Number(state.val) || 0, 1);
            const currentGuardFailsafe = guard.failsafeLimit || 0;
            const currentSum = this.#guards.reduce((sum, g) => sum + (g.failsafeLimit || 0), 0);
            const newSum = currentSum - currentGuardFailsafe + newValue;
            const nominalMax = this.#config.contractualProductionNominalMax || 4200;

            if (newSum > nominalMax) {
                log.warn(
                    `LPP rejecting failsafe limit ${newValue}W for guard "${guardName}" — sum would be ${newSum}W, exceeding contractual max ${nominalMax}W`,
                );
                await this.#adapter.setStateAsync(`${guard.basePath}.failsafeLimit`, currentGuardFailsafe, true);
                return;
            }

            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPP manual energy guard "${guardName}" failsafeLimit changed to ${newValue}`);
                await guard.onFailsafeLimitWrite(newValue);
                await this.#updateReportedFailsafe();
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            } else if (guard instanceof EebusEnergyGuard) {
                log.info(`LPP EEBUS energy guard "${guardName}" failsafeLimit changed to ${newValue}`);
                await guard.onFailsafeLimitWrite(newValue);
            }
        } else if (stateName === 'failsafeDuration') {
            if (guard instanceof EebusEnergyGuard) {
                const durationS = Number(state.val) || 0;
                log.info(`LPP EEBUS energy guard "${guardName}" failsafeDuration changed to ${durationS}s`);
                await guard.onFailsafeDurationWrite(durationS);
            }
        } else if (stateName === 'manualLimit') {
            if (guard instanceof EebusEnergyGuard) {
                if (this.#controlBoxConnected && this.#lastLimitActive) {
                    log.warn(`Rejecting manual limit for LPP guard "${guardName}" — control box has an active limit`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    return;
                }

                const limitW = Number(state.val) || 0;
                log.info(`LPP EEBUS energy guard "${guardName}" manualLimit changed to ${limitW}`);

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

                if (limitW > 0) {
                    const durationNs = 60 * 60 * 1_000_000_000; // 60 minutes in nanoseconds
                    await callUnary(egLppClient, 'WriteProductionLimit', {
                        instance_id: guard.instanceId,
                        remote_ski: guard.ski,
                        remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                        limit: {
                            is_active: true,
                            value: -limitW,
                            duration_nanoseconds: durationNs,
                        },
                    });
                    log.info(`Manual production limit ${limitW}W sent to LPP guard "${guardName}" (duration: 60min)`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, limitW, true);

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
                                        remote_entity_address: {
                                            entity_address: guard.remoteEntityAddress || [],
                                        },
                                        limit: { is_active: false, value: 0 },
                                    });
                                }
                            } catch (err) {
                                if (isTransportError(err)) {
                                    log.error(
                                        `LPP manual limit expiry gRPC transport error for guard "${guardName}": ${err.message} — triggering reconnect`,
                                    );
                                    this.#onGrpcError();
                                } else {
                                    log.warn(
                                        `Failed to deactivate expired manual production limit for LPP guard "${guardName}": ${err.message}`,
                                    );
                                }
                            }
                            await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                        },
                        60 * 60 * 1000,
                    );
                    this.#manualLimitTimers.set(guardName, timer);
                } else {
                    await callUnary(egLppClient, 'WriteProductionLimit', {
                        instance_id: guard.instanceId,
                        remote_ski: guard.ski,
                        remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                        limit: { is_active: false, value: 0 },
                    });
                    log.info(`Manual production limit deactivated for LPP guard "${guardName}"`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                }
            }
        }
    }

    // ─── Internal: Guard Initialization ─────────────────────────────────

    async #initEnergyGuards() {
        const config = this.#config;
        const log = this.#adapter.log;
        const guardConfigs = config.lppEnergyGuards || [];

        if (guardConfigs.length === 0) {
            await this.#cleanupRemovedGuards(guardConfigs);
            return;
        }

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

                const entityAddr = this.#lpcEntityMap.get(entry.ski);
                if (!entityAddr) {
                    throw new Error(`No EG entity found for LPP guard "${entry.name}" SKI=${entry.ski}`);
                }
                const res = await callUnary(this.#controlClient, 'AddUseCase', {
                    entity_address: { entity_address: entityAddr },
                    use_case: { actor: 'EnergyGuard', name: 'limitationOfPowerProduction' },
                });
                const instanceId = res.instance_id;
                if (!instanceId) {
                    throw new Error(`AddUseCase returned empty instance_id for LPP guard "${entry.name}"`);
                }
                this.#egLppEndpoints.set(entry.ski, { instanceId, entityAddr });
                log.info(
                    `EG-LPP UseCase added for guard "${entry.name}" at entity [${entityAddr}], instance_id: ${instanceId}`,
                );

                await registerRemoteSki(this.#controlClient, entry.ski);
                log.info(`Registered remote SKI for LPP guard "${entry.name}": ${entry.ski}`);
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

        if (this.#egLppEndpoints.size > 0) {
            this.#subscribeEgLppEvents();
        }

        await this.#cleanupRemovedGuards(guardConfigs);

        // Restore persisted failsafe limits from ioBroker state so that the
        // reported sum is correct even before remote devices confirm their values.
        for (const guard of this.#guards) {
            try {
                const state = await this.#adapter.getStateAsync(`${guard.basePath}.failsafeLimit`);
                if (state && state.val != null && Number(state.val) > 0) {
                    await guard.setFailsafeLimit(Number(state.val));
                }
            } catch {
                // Ignore — guard starts with failsafe 0
            }
        }

        log.info(`Initialized ${this.#guards.length} LPP energy guard(s)`);
        await this.#updateReportedFailsafe();
    }

    async #cleanupRemovedGuards(guardConfigs) {
        const log = this.#adapter.log;
        const adapterNamespace = this.#adapter.namespace;
        const expectedNames = new Set(guardConfigs.map(entry => `LPP.EnergyGuards.Guard_${entry.name}`));

        try {
            const objects = await this.#adapter.getAdapterObjectsAsync();
            const channelIds = Object.keys(objects).filter(id => {
                const localId = id.replace(`${adapterNamespace}.`, '');
                return localId.startsWith('LPP.EnergyGuards.Guard_') && objects[id].type === 'channel';
            });

            for (const fullId of channelIds) {
                const localId = fullId.replace(`${adapterNamespace}.`, '');
                if (!expectedNames.has(localId)) {
                    log.info(`Removing objects for deleted LPP energy guard: ${localId}`);
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

    // ─── Internal: EG-LPP Event Subscription ────────────────────────────

    #subscribeEgLppEvents() {
        const log = this.#adapter.log;

        for (const [ski, { instanceId, entityAddr }] of this.#egLppEndpoints) {
            const stream = this.#controlClient.SubscribeUseCaseEvents({
                instance_id: instanceId,
            });

            this.#egLppStreams.push(stream);

            stream.on('data', async evt => {
                try {
                    const remoteSki = evt.remote_ski;
                    const eventName = evt.use_case_event && evt.use_case_event.event;
                    log.debug(
                        `EG-LPP event for entity [${entityAddr}]: remote_ski="${remoteSki || ''}", event=${eventName}`,
                    );

                    if (remoteSki !== ski) {
                        log.debug(
                            `EG-LPP event SKI mismatch for guard SKI=${ski}: got remote_ski="${remoteSki || ''}", event=${eventName}`,
                        );
                        return;
                    }

                    const guard = this.#guards.find(g => g instanceof EebusEnergyGuard && g.ski === ski);
                    if (!guard) {
                        return;
                    }

                    // Any event from the remote device resets the heartbeat timer,
                    // keeping the guard connected even if the device does not support
                    // explicit heartbeat notifications.
                    if (guard.egLpcClient) {
                        await guard.updateHeartbeat();
                        guard.resetHeartbeatTimer();
                    }

                    if (eventName === 'UseCaseSupportUpdate') {
                        if (!guard.egLpcClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const egLppClient = makeClient({
                                protoDir: PROTO_DIR,
                                protoRelPath: 'usecases/eg/lpp/service.proto',
                                pkg: 'eg_lpp',
                                service: 'EnergyGuardLPPControl',
                                endpoint: getEndpoint(this.#controlClient),
                            });
                            await guard.assignUseCaseClient(egLppClient, instanceId, remoteSki, remoteEntityAddr);
                            log.info(
                                `EG-LPP client assigned to guard "${guard.name}" (SKI=${ski}, remoteEntity=[${remoteEntityAddr}])`,
                            );
                        }
                    } else if (eventName === 'DataUpdateHeartbeat') {
                        await guard.handleHeartbeat();
                        log.silly(`LPP heartbeat received for guard "${guard.name}" (SKI=${ski})`);
                    } else if (eventName === 'DataUpdateFailsafeProductionActivePowerLimit') {
                        const egLppClient = guard.egLpcClient;
                        if (egLppClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLppClient, 'FailsafeProductionActivePowerLimit', {
                                instance_id: guard.instanceId,
                                remote_ski: ski,
                                remote_entity_address: { entity_address: remoteEntityAddr },
                            });
                            const failsafeValue = res.limit || 0;
                            const changed = await guard.setFailsafeLimit(failsafeValue);
                            if (changed) {
                                log.info(`LPP failsafe limit updated for guard "${guard.name}": ${failsafeValue}W`);
                                await this.#updateReportedFailsafe();
                                if (this.#lastLimitActive) {
                                    await this.#distributeLimit(true);
                                }
                            } else {
                                log.debug(`LPP failsafe limit unchanged for guard "${guard.name}": ${failsafeValue}W`);
                            }
                        }
                    } else if (eventName === 'DataUpdateLimit') {
                        const egLppClient = guard.egLpcClient;
                        if (egLppClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLppClient, 'ProductionLimit', {
                                instance_id: guard.instanceId,
                                remote_ski: ski,
                                remote_entity_address: { entity_address: remoteEntityAddr },
                            });
                            const limit = res.limit || {};
                            const isActive = !!limit.is_active;
                            const confirmedValue = isActive ? Math.abs(limit.value || 0) : 0;
                            await this.#adapter.setStateAsync(`${guard.basePath}.confirmedLimit`, confirmedValue, true);
                        }
                    } else if (eventName === 'DataUpdatePowerProductionNominalMax') {
                        const nominalMax = await guard.onRemoteNominalMaxUpdate(
                            'ProductionNominalMax',
                            'production_nominal_max',
                        );
                        log.info(`LPP nominal max power updated for guard "${guard.name}": ${nominalMax}W`);
                    } else if (eventName === 'DataUpdateFailsafeDurationMinimum') {
                        const egLppClient = guard.egLpcClient;
                        if (egLppClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLppClient, 'FailsafeDurationMinimum', {
                                instance_id: guard.instanceId,
                                remote_ski: ski,
                                remote_entity_address: { entity_address: remoteEntityAddr },
                            });
                            const durationS = Math.round((res.duration_nanoseconds || 0) / 1_000_000_000);
                            const prev = await this.#adapter.getStateAsync(`${guard.basePath}.failsafeDuration`);
                            if (!prev || prev.val !== durationS) {
                                await this.#adapter.setStateAsync(
                                    `${guard.basePath}.failsafeDuration`,
                                    durationS,
                                    true,
                                );
                                log.info(`LPP failsafe duration updated for guard "${guard.name}": ${durationS}s`);
                            } else {
                                log.debug(`LPP failsafe duration unchanged for guard "${guard.name}": ${durationS}s`);
                            }
                        }
                    } else {
                        log.debug(`EG-LPP event "${eventName}" for guard "${guard.name}" — no action needed`);
                    }
                } catch (err) {
                    if (isTransportError(err)) {
                        log.error(`EG-LPP event handler gRPC transport error: ${err.message} — triggering reconnect`);
                        this.#onGrpcError();
                    } else {
                        log.warn(`EG-LPP event handler error: ${err.message}`);
                    }
                }
            });

            stream.on('error', err => {
                if (this.#stopped) {
                    log.debug(`EG-LPP event stream closed for SKI=${ski}: ${err.message}`);
                    return;
                }
                log.error(`EG-LPP event stream error for SKI=${ski}: ${err.message} — triggering reconnect`);
                this.#onGrpcError();
            });

            stream.on('end', () => {
                if (this.#stopped) {
                    log.debug(`EG-LPP event stream ended for SKI=${ski} (shutdown)`);
                    return;
                }
                log.warn(`EG-LPP event stream ended for SKI=${ski} — triggering reconnect`);
                this.#onGrpcError();
            });
        }
    }

    // ─── Internal: Limit Distribution ───────────────────────────────────

    async #distributeLimit(isActive) {
        const log = this.#adapter.log;
        log.info(`LPP distributeLimit called: isActive=${isActive}, guards=${this.#guards.length}`);
        this.#lastLimitActive = isActive;

        if (!isActive) {
            for (const guard of this.#guards) {
                if (guard instanceof EebusEnergyGuard) {
                    await this.#adapter.setStateAsync(`${guard.basePath}.currentLimit`, 0, true);
                    const egLppClient = guard.egLpcClient;
                    if (egLppClient && guard.isConnected()) {
                        await callUnary(egLppClient, 'WriteProductionLimit', {
                            instance_id: guard.instanceId,
                            remote_ski: guard.ski,
                            remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                            limit: { is_active: false, value: 0 },
                        });
                    }
                } else {
                    await guard.deactivateLimit();
                }
            }
            return;
        }

        const totalLimit = this.#currentLimitValue;
        log.info(`LPP distributeLimit: using stored totalLimit=${totalLimit}`);

        if (totalLimit <= 0) {
            log.warn('Production limit is active but value is 0 — skipping distribution');
            return;
        }

        // Read all percentages from guards (connection state no longer affects distribution)
        const guardData = [];
        for (const guard of this.#guards) {
            const pct = await guard.getPercentage();
            guardData.push({ pct, failsafeLimit: guard.failsafeLimit });
        }

        const effectiveLimits = distributeLimit(totalLimit, guardData);

        // Compute remaining duration to forward to downstream devices
        let remainingDurationNs = 0;
        if (this.#currentLimitDurationNs > 0 && this.#limitReceivedAt) {
            const elapsedMs = Date.now() - this.#limitReceivedAt;
            const elapsedNs = elapsedMs * 1_000_000;
            remainingDurationNs = Math.max(0, this.#currentLimitDurationNs - elapsedNs);
        }

        // Apply calculated limits to guards
        for (let i = 0; i < this.#guards.length; i++) {
            const guard = this.#guards[i];
            const effectiveLimit = effectiveLimits[i];

            if (guard instanceof EebusEnergyGuard) {
                await this.#adapter.setStateAsync(`${guard.basePath}.currentLimit`, effectiveLimit, true);
                const egLppClient = guard.egLpcClient;
                if (egLppClient && guard.isConnected()) {
                    const limitMsg = { is_active: true, value: -effectiveLimit };
                    if (remainingDurationNs > 0) {
                        limitMsg.duration_nanoseconds = remainingDurationNs;
                    }
                    await callUnary(egLppClient, 'WriteProductionLimit', {
                        instance_id: guard.instanceId,
                        remote_ski: guard.ski,
                        remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                        limit: limitMsg,
                    });
                }
            } else {
                await guard.applyEffectiveLimit(effectiveLimit, remainingDurationNs);
            }
        }
    }

    // ─── Internal: Failsafe Reporting ───────────────────────────────────

    async #updateReportedFailsafe() {
        if (!this.#csLppClient) {
            return;
        }
        const failsafeSum = this.#guards.reduce((sum, guard) => sum + (guard.failsafeLimit || 0), 0);
        const nominalMax = this.#config.contractualProductionNominalMax || 4200;
        if (failsafeSum > nominalMax) {
            this.#adapter.log.warn(
                `LPP sum of guard failsafe limits (${failsafeSum}W) exceeds contractual nominal max (${nominalMax}W) — devices may violate the grid contract in failsafe`,
            );
        }
        await callUnary(this.#csLppClient, 'SetFailsafeProductionActivePowerLimit', {
            instance_id: this.#csLppInstanceId,
            value: -failsafeSum,
            is_changeable: false,
        });
        this.#adapter.log.info(`LPP reported failsafe limit to controlbox: ${failsafeSum}W`);
    }
}

/**
 * Distribute a power limit budget across energy guards by configured percentage.
 *
 * Algorithm:
 * 1. Normalize percentages if their sum exceeds 100%
 * 2. Iteratively pin guards at their failsafe limit when their percentage-based
 *    share of the remaining budget falls below the failsafe floor
 * 3. Subtract pinned guards' failsafe from the budget and restart
 * 4. Distribute remaining budget to unpinned guards proportionally
 * 5. Floor every result at 1W
 *
 * @param {number} budget - Total power limit to distribute (watts)
 * @param {Array<{pct: number, failsafeLimit: number}>} guards - Per-guard config
 * @returns {number[]} Effective limit per guard (watts)
 */
function distributeLimit(budget, guards) {
    if (guards.length === 0) {
        return [];
    }

    // Normalize percentages if sum > 100%
    const pcts = guards.map(g => g.pct);
    const pctSum = pcts.reduce((acc, p) => acc + p, 0);
    const scale = pctSum > 100 ? 100 / pctSum : 1;
    const normalizedPcts = pcts.map(p => p * scale);

    // Iterative pinning: pin guards whose share falls below their failsafe
    const pinned = new Array(guards.length).fill(false);
    let remainingBudget = budget;
    let changed = true;

    while (changed) {
        changed = false;
        for (let i = 0; i < guards.length; i++) {
            if (pinned[i]) {
                continue;
            }
            if ((normalizedPcts[i] / 100) * remainingBudget < guards[i].failsafeLimit) {
                pinned[i] = true;
                remainingBudget -= guards[i].failsafeLimit;
                changed = true;
                break;
            }
        }
    }

    // Sum of unpinned percentages for proportional split
    let unpinnedPctSum = 0;
    for (let i = 0; i < guards.length; i++) {
        if (!pinned[i]) {
            unpinnedPctSum += normalizedPcts[i];
        }
    }

    // Build result: pinned → failsafe, unpinned → proportional share, floor at 1W
    const result = new Array(guards.length);
    for (let i = 0; i < guards.length; i++) {
        if (pinned[i]) {
            result[i] = Math.max(guards[i].failsafeLimit, 1);
        } else {
            const share = unpinnedPctSum > 0 ? (normalizedPcts[i] / unpinnedPctSum) * remainingBudget : 0;
            result[i] = Math.max(share, 1);
        }
    }

    return result;
}

/**
 * Reset manual limits on all EEBUS energy guards.
 *
 * When the control box limit becomes active, all manual limits must be deactivated:
 * - Cancel any running manual limit timers
 * - Send WriteProductionLimit(deactivate) to connected guards via their EG-LPP client
 * - Reset manualLimit ioBroker state to 0
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

module.exports = { EgLpp, distributeLimit, resetManualLimits };
