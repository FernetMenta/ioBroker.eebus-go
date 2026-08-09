'use strict';

const path = require('node:path');
const { makeClient, callUnary, isTransportError } = require('./grpc-client');
const { EebusEnergyGuard, ManualEnergyGuard } = require('./energy-guard');
const { registerRemoteSki } = require('./grpc-service');
const { distributeConsumptionLimit } = require('./lpc-use-case');

/**
 * Root directory for protobuf definitions.
 */
const PROTO_DIR = path.join(__dirname, 'protobuf');

/**
 * EG-LPC: Energy Guard management for Limitation of Power Consumption.
 *
 * Responsibilities:
 *  - Initialize and manage LPC energy guards (EEBUS + manual)
 *  - Subscribe to EG-LPC gRPC events (pairing, heartbeat, failsafe, limit confirmation)
 *  - Distribute consumption limits to guards
 *  - Report failsafe sum to the controlbox (via CS-LPC client)
 *  - Handle guard state changes (percentage, heartbeat, connected, failsafeLimit, manualLimit)
 *  - Manage manual limit timers
 *  - Track control box connection state for manual limit gating
 *
 * This class is owned by Hems and does NOT know about the FSM or CS-LPC events.
 * It receives limit updates via distributeLimit() called by Hems.
 */
class EgLpc {
    #adapter;
    #config;
    #controlClient;
    #csLpcClient;
    #translate;
    #onGrpcError;
    #guards;
    #egLpcEndpoints;
    #egEntityMap;
    #lastLimitActive;
    #currentLimitValue;
    #controlBoxConnected;
    #manualLimitTimers;

    /**
     * Create a new EgLpc instance.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {object} config - Adapter configuration (native object)
     * @param {object} controlClient - gRPC ControlService client (shared)
     * @param {object} csLpcClient - CS-LPC gRPC client (for SetFailsafeConsumptionActivePowerLimit)
     * @param {(key: string) => string} translate - I18n translate function
     * @param {object} [callbacks] - Optional callback functions
     * @param {() => void} [callbacks.onGrpcError] - Called when a gRPC call fails (triggers reconnect)
     */
    constructor(adapter, config, controlClient, csLpcClient, translate, { onGrpcError } = {}) {
        this.#adapter = adapter;
        this.#config = config;
        this.#controlClient = controlClient;
        this.#csLpcClient = csLpcClient;
        this.#translate = translate || (key => key);
        this.#onGrpcError = onGrpcError || (() => {});
        this.#guards = [];
        this.#egLpcEndpoints = new Map();
        this.#egEntityMap = new Map();
        this.#lastLimitActive = false;
        this.#currentLimitValue = 0;
        this.#controlBoxConnected = false;
        this.#manualLimitTimers = new Map();
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
     * Registers EG-LPC use cases on pre-created entities, subscribes to EG events.
     *
     * @param {Map<string, number[]>} egEntityMap - Map of SKI → entity address (created by Hems)
     */
    async start(egEntityMap) {
        this.#egEntityMap = egEntityMap || new Map();
        await this.#initEnergyGuards();
    }

    /**
     * Stop and clean up all EG-LPC resources.
     */
    stop() {
        for (const timer of this.#manualLimitTimers.values()) {
            this.#adapter.clearTimeout(timer);
        }
        this.#manualLimitTimers.clear();
        for (const guard of this.#guards) {
            if (guard instanceof EebusEnergyGuard && guard.egLpcClient) {
                guard.egLpcClient.close();
            }
        }
    }

    /**
     * Distribute a consumption limit to all energy guards.
     * Called by Hems when the CS-LPC reports a limit update.
     *
     * @param {boolean} isActive - Whether the limit is active
     * @param {number} limitValue - The limit value in watts (0 if deactivated)
     */
    async distributeLimit(isActive, limitValue) {
        this.#currentLimitValue = limitValue;
        try {
            await this.#distributeLimit(isActive);
        } catch (err) {
            if (isTransportError(err)) {
                this.#adapter.log.error(
                    `LPC distributeLimit gRPC transport error: ${err.message} — triggering reconnect`,
                );
                this.#onGrpcError();
            } else {
                this.#adapter.log.warn(`LPC distributeLimit error: ${err.message}`);
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
        log.info(`LPC control box connection state: ${connected}`);

        if (connected) {
            // Reset manual limits on all EEBUS guards — control box takes over
            for (const guard of this.#guards) {
                if (guard instanceof EebusEnergyGuard) {
                    const timer = this.#manualLimitTimers.get(guard.name);
                    if (timer) {
                        this.#adapter.clearTimeout(timer);
                        this.#manualLimitTimers.delete(guard.name);
                    }
                    try {
                        await guard.onManualLimitWrite(0);
                        await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    } catch (err) {
                        if (isTransportError(err)) {
                            log.error(
                                `LPC setControlBoxConnected gRPC transport error: ${err.message} — triggering reconnect`,
                            );
                            this.#onGrpcError();
                            return;
                        }
                        log.warn(`Failed to reset manual limit for LPC guard "${guard.name}": ${err.message}`);
                    }
                }
            }
        }
    }

    /**
     * Handle state changes for LPC Energy Guard states.
     *
     * @param {string} localId - Local state ID (e.g., "LPC.EnergyGuards.Guard_WallBox.percentage")
     * @param {ioBroker.State} state - State object (only ack=false writes are forwarded here)
     */
    async handleGuardStateChange(localId, state) {
        try {
            await this.#handleGuardStateChange(localId, state);
        } catch (err) {
            if (isTransportError(err)) {
                this.#adapter.log.error(
                    `LPC handleGuardStateChange gRPC transport error: ${err.message} — triggering reconnect`,
                );
                this.#onGrpcError();
            } else {
                this.#adapter.log.warn(`LPC handleGuardStateChange error: ${err.message}`);
            }
        }
    }

    async #handleGuardStateChange(localId, state) {
        const log = this.#adapter.log;
        log.debug(`LPC handleGuardStateChange: ${localId} = ${state.val}`);

        const parts = localId.split('.');
        if (parts[0] !== 'LPC' || parts.length < 4) {
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
            log.debug(`No LPC energy guard found for name "${guardName}" — ignoring state change`);
            return;
        }

        if (stateName === 'percentage') {
            log.info(`LPC energy guard "${guardName}" percentage changed to ${state.val}`);
            await this.#adapter.setStateAsync(`${guard.basePath}.percentage`, state.val, true);
            if (this.#lastLimitActive) {
                await this.#distributeLimit(true);
            }
        } else if (stateName === 'heartbeat') {
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPC manual energy guard "${guardName}" heartbeat write received`);
                await guard.onHeartbeatWrite();
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        } else if (stateName === 'connected') {
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPC manual energy guard "${guardName}" connected changed to ${state.val}`);
                await guard.onConnectedWrite(state.val);
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        } else if (stateName === 'failsafeLimit') {
            const newValue = Number(state.val) || 0;
            const currentGuardFailsafe = guard.failsafeLimit || 0;
            const currentSum = this.#guards.reduce((sum, g) => sum + (g.failsafeLimit || 0), 0);
            const newSum = currentSum - currentGuardFailsafe + newValue;
            const nominalMax = this.#config.contractualConsumptionNominalMax || 32000;

            if (newSum > nominalMax) {
                log.warn(
                    `LPC rejecting failsafe limit ${newValue}W for guard "${guardName}" — sum would be ${newSum}W, exceeding contractual max ${nominalMax}W`,
                );
                await this.#adapter.setStateAsync(`${guard.basePath}.failsafeLimit`, currentGuardFailsafe, true);
                return;
            }

            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPC manual energy guard "${guardName}" failsafeLimit changed to ${newValue}`);
                await guard.onFailsafeLimitWrite(newValue);
                await this.#updateReportedFailsafe();
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            } else if (guard instanceof EebusEnergyGuard) {
                log.info(`LPC EEBUS energy guard "${guardName}" failsafeLimit changed to ${newValue}`);
                await guard.onFailsafeLimitWrite(newValue);
            }
        } else if (stateName === 'failsafeDuration') {
            if (guard instanceof EebusEnergyGuard) {
                const durationS = Number(state.val) || 0;
                log.info(`LPC EEBUS energy guard "${guardName}" failsafeDuration changed to ${durationS}s`);
                await guard.onFailsafeDurationWrite(durationS);
            }
        } else if (stateName === 'manualLimit') {
            if (guard instanceof EebusEnergyGuard) {
                if (this.#controlBoxConnected && this.#lastLimitActive) {
                    log.warn(`Rejecting manual limit for LPC guard "${guardName}" — control box has an active limit`);
                    await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    return;
                }

                const limitW = Number(state.val) || 0;
                log.info(`LPC EEBUS energy guard "${guardName}" manualLimit changed to ${limitW}`);

                const existingTimer = this.#manualLimitTimers.get(guardName);
                if (existingTimer) {
                    this.#adapter.clearTimeout(existingTimer);
                    this.#manualLimitTimers.delete(guardName);
                }

                await guard.onManualLimitWrite(limitW);
                await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, limitW, true);

                if (limitW > 0) {
                    const timer = this.#adapter.setTimeout(
                        async () => {
                            this.#manualLimitTimers.delete(guardName);
                            log.info(
                                `Manual consumption limit duration expired for LPC guard "${guardName}" — deactivating`,
                            );
                            try {
                                await guard.onManualLimitWrite(0);
                            } catch (err) {
                                if (isTransportError(err)) {
                                    log.error(
                                        `LPC manual limit expiry gRPC transport error for guard "${guardName}": ${err.message} — triggering reconnect`,
                                    );
                                    this.#onGrpcError();
                                } else {
                                    log.warn(
                                        `Failed to deactivate expired manual consumption limit for LPC guard "${guardName}": ${err.message}`,
                                    );
                                }
                            }
                            await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                        },
                        60 * 60 * 1000,
                    );
                    this.#manualLimitTimers.set(guardName, timer);
                }
            }
        }
    }

    // ─── Internal: Guard Initialization ─────────────────────────────────

    async #initEnergyGuards() {
        const config = this.#config;
        const log = this.#adapter.log;
        const guardConfigs = config.energyGuards || [];

        if (guardConfigs.length === 0) {
            await this.#cleanupRemovedGuards(guardConfigs);
            return;
        }

        await this.#adapter.extendObjectAsync('LPC.EnergyGuards', {
            type: 'folder',
            common: { name: 'LPC Energy Guards' },
            native: {},
        });

        const seenSkis = new Set();
        this.#guards = [];
        this.#egLpcEndpoints.clear();

        for (const entry of guardConfigs) {
            if (entry.type === 'eebus') {
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

                const entityAddr = this.#egEntityMap.get(entry.ski);
                if (!entityAddr) {
                    throw new Error(`No EG entity found for LPC guard "${entry.name}" SKI=${entry.ski}`);
                }
                const res = await callUnary(this.#controlClient, 'AddUseCase', {
                    entity_address: { entity_address: entityAddr },
                    use_case: { actor: 'EnergyGuard', name: 'limitationOfPowerConsumption' },
                });
                const endpoint = res.endpoint;
                if (!endpoint) {
                    throw new Error(`AddUseCase returned empty endpoint for LPC guard "${entry.name}"`);
                }
                this.#egLpcEndpoints.set(entry.ski, { endpoint, entityAddr });
                log.info(
                    `EG-LPC UseCase added for guard "${entry.name}" at entity [${entityAddr}], endpoint: ${endpoint}`,
                );

                await registerRemoteSki(this.#controlClient, entry.ski);
                log.info(`Registered remote SKI for LPC guard "${entry.name}": ${entry.ski}`);
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

        if (this.#egLpcEndpoints.size > 0) {
            this.#subscribeEgLpcEvents();
        }

        await this.#cleanupRemovedGuards(guardConfigs);
        log.info(`Initialized ${this.#guards.length} LPC energy guard(s)`);
        await this.#updateReportedFailsafe();
    }

    async #cleanupRemovedGuards(guardConfigs) {
        const log = this.#adapter.log;
        const adapterNamespace = this.#adapter.namespace;
        const expectedNames = new Set(guardConfigs.map(entry => `LPC.EnergyGuards.Guard_${entry.name}`));

        try {
            const objects = await this.#adapter.getAdapterObjectsAsync();
            const channelIds = Object.keys(objects).filter(id => {
                const localId = id.replace(`${adapterNamespace}.`, '');
                return localId.startsWith('LPC.EnergyGuards.Guard_') && objects[id].type === 'channel';
            });

            for (const fullId of channelIds) {
                const localId = fullId.replace(`${adapterNamespace}.`, '');
                if (!expectedNames.has(localId)) {
                    log.info(`Removing objects for deleted LPC energy guard: ${localId}`);
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

    // ─── Internal: EG-LPC Event Subscription ────────────────────────────

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
                try {
                    const remoteSki = evt.remote_ski;
                    const eventName = evt.use_case_event && evt.use_case_event.event;
                    log.debug(
                        `EG-LPC event for entity [${entityAddr}]: remote_ski="${remoteSki || ''}", event=${eventName}`,
                    );

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
                            const egLpcClient = makeClient({
                                protoDir: PROTO_DIR,
                                protoRelPath: 'usecases/eg/lpc/service.proto',
                                pkg: 'eg_lpc',
                                service: 'EnergyGuardLPCControl',
                                endpoint,
                            });
                            await guard.assignUseCaseClient(egLpcClient, remoteSki, remoteEntityAddr);
                            log.info(
                                `EG-LPC client assigned to guard "${guard.name}" (SKI=${ski}, remoteEntity=[${remoteEntityAddr}])`,
                            );
                        }
                    } else if (eventName === 'DataUpdateHeartbeat') {
                        await guard.handleHeartbeat();
                        log.silly(`LPC heartbeat received for guard "${guard.name}" (SKI=${ski})`);
                        if (this.#lastLimitActive) {
                            await this.#distributeLimit(true);
                        }
                    } else if (eventName === 'DataUpdateFailsafeConsumptionActivePowerLimit') {
                        const egLpcClient = guard.egLpcClient;
                        if (egLpcClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLpcClient, 'FailsafeConsumptionActivePowerLimit', {
                                remote_ski: ski,
                                remote_entity_address: { entity_address: remoteEntityAddr },
                            });
                            const failsafeValue = res.limit || 0;
                            const changed = await guard.setFailsafeLimit(failsafeValue);
                            if (changed) {
                                log.info(`LPC failsafe limit updated for guard "${guard.name}": ${failsafeValue}W`);
                                await this.#updateReportedFailsafe();
                            } else {
                                log.debug(`LPC failsafe limit unchanged for guard "${guard.name}": ${failsafeValue}W`);
                            }
                        }
                        if (this.#lastLimitActive) {
                            await this.#distributeLimit(true);
                        }
                    } else if (eventName === 'DataUpdateLimit') {
                        const egLpcClient = guard.egLpcClient;
                        if (egLpcClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLpcClient, 'ConsumptionLimit', {
                                remote_ski: ski,
                                remote_entity_address: { entity_address: remoteEntityAddr },
                            });
                            const limit = res.limit || {};
                            const isActive = !!limit.is_active;
                            const confirmedValue = isActive ? limit.value || 0 : 0;
                            await this.#adapter.setStateAsync(`${guard.basePath}.confirmedLimit`, confirmedValue, true);
                        }
                    } else if (eventName === 'DataUpdatePowerConsumptionNominalMax') {
                        const egLpcClient = guard.egLpcClient;
                        if (egLpcClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLpcClient, 'ConsumptionNominalMax', {
                                remote_ski: ski,
                                remote_entity_address: { entity_address: remoteEntityAddr },
                            });
                            const nominalMax = res.consumption_nominal_max || 0;
                            await this.#adapter.setStateAsync(`${guard.basePath}.nominalMax`, nominalMax, true);
                            log.info(`LPC nominal max power updated for guard "${guard.name}": ${nominalMax}W`);
                        }
                    } else if (eventName === 'DataUpdateFailsafeDurationMinimum') {
                        const egLpcClient = guard.egLpcClient;
                        if (egLpcClient) {
                            const remoteEntityAddr =
                                evt.remote_entity_address && evt.remote_entity_address.entity_address;
                            const res = await callUnary(egLpcClient, 'FailsafeDurationMinimum', {
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
                                log.info(`LPC failsafe duration updated for guard "${guard.name}": ${durationS}s`);
                            } else {
                                log.debug(`LPC failsafe duration unchanged for guard "${guard.name}": ${durationS}s`);
                            }
                        }
                    } else {
                        log.debug(`EG-LPC event "${eventName}" for guard "${guard.name}" — no action needed`);
                    }
                } catch (err) {
                    if (isTransportError(err)) {
                        log.error(`EG-LPC event handler gRPC transport error: ${err.message} — triggering reconnect`);
                        this.#onGrpcError();
                    } else {
                        log.warn(`EG-LPC event handler error: ${err.message}`);
                    }
                }
            });

            stream.on('error', err => {
                log.error(`EG-LPC event stream error for SKI=${ski}: ${err.message} — triggering reconnect`);
                this.#onGrpcError();
            });

            stream.on('end', () => {
                log.warn(`EG-LPC event stream ended for SKI=${ski} — triggering reconnect`);
                this.#onGrpcError();
            });
        }
    }

    // ─── Internal: Limit Distribution ───────────────────────────────────

    async #distributeLimit(isActive) {
        const log = this.#adapter.log;
        log.info(`LPC distributeLimit called: isActive=${isActive}, guards=${this.#guards.length}`);
        const wasActive = this.#lastLimitActive;
        this.#lastLimitActive = isActive;

        if (!isActive) {
            for (const guard of this.#guards) {
                await guard.deactivateLimit();
            }
            return;
        }

        const controlboxLimit = this.#currentLimitValue;
        log.info(`LPC distributeLimit: using stored controlboxLimit=${controlboxLimit}`);
        if (controlboxLimit <= 0) {
            log.warn('LPC controlbox limit is active but value is 0 — skipping distribution');
            return;
        }

        // Controlbox limit just became active — reset any manual limits on EEBUS guards
        if (!wasActive) {
            for (const guard of this.#guards) {
                if (guard instanceof EebusEnergyGuard) {
                    const manualState = await this.#adapter.getStateAsync(`${guard.basePath}.manualLimit`);
                    if (manualState && manualState.val) {
                        log.info(`LPC controlbox limit activated — resetting manual limit for guard "${guard.name}"`);
                        await guard.onManualLimitWrite(0);
                        await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    }
                }
            }
        }

        // Read all percentages and connection states from guards
        const guardData = [];
        for (const guard of this.#guards) {
            const pct = await guard.getPercentage();
            const connected = guard.isConnected();
            guardData.push({ pct, connected, failsafeLimit: guard.failsafeLimit });
        }

        const effectiveLimits = distributeConsumptionLimit(controlboxLimit, guardData);

        for (let i = 0; i < this.#guards.length; i++) {
            const limitInfo = effectiveLimits[i];
            if (limitInfo.skip) {
                continue;
            }
            await this.#guards[i].applyEffectiveLimit(limitInfo.effectiveLimit);
            log.info(
                `LPC guard "${this.#guards[i].name}": pct=${guardData[i].pct}%, effectiveLimit=${limitInfo.effectiveLimit.toFixed(1)}W`,
            );
        }
    }

    // ─── Internal: Failsafe Reporting ───────────────────────────────────

    async #updateReportedFailsafe() {
        if (!this.#csLpcClient) {
            return;
        }
        const failsafeSum = this.#guards.reduce((sum, guard) => sum + (guard.failsafeLimit || 0), 0);
        const nominalMax = this.#config.contractualConsumptionNominalMax || 32000;
        if (failsafeSum > nominalMax) {
            this.#adapter.log.warn(
                `LPC sum of guard failsafe limits (${failsafeSum}W) exceeds contractual nominal max (${nominalMax}W) — devices may violate the grid contract in failsafe`,
            );
        }
        await callUnary(this.#csLpcClient, 'SetFailsafeConsumptionActivePowerLimit', {
            value: failsafeSum,
            is_changeable: false,
        });
        this.#adapter.log.info(`LPC reported failsafe limit to controlbox: ${failsafeSum}W`);
    }
}

module.exports = { EgLpc };
