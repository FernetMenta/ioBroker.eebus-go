'use strict';

const path = require('node:path');
const { makeClient, callUnary } = require('./grpc-client');
const { EebusEnergyGuard, ManualEnergyGuard } = require('./energy-guard');
const { registerRemoteSki } = require('./grpc-service');
const { distributeProductionLimit, resetManualLimits } = require('./lpp-use-case');

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
    #translate;
    #guards;
    #egLppEndpoints;
    #lpcEntityMap;
    #egLppStreams;
    #lastLimitActive;
    #currentLimitValue;
    #controlBoxConnected;
    #manualLimitTimers;

    /**
     * Create a new EgLpp instance.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {object} config - Adapter configuration (native object)
     * @param {object} controlClient - gRPC ControlService client (shared)
     * @param {object} csLppClient - CS-LPP gRPC client (for SetFailsafeProductionActivePowerLimit)
     * @param {(key: string) => string} translate - I18n translate function
     */
    constructor(adapter, config, controlClient, csLppClient, translate) {
        this.#adapter = adapter;
        this.#config = config;
        this.#controlClient = controlClient;
        this.#csLppClient = csLppClient;
        this.#translate = translate || (key => key);
        this.#guards = [];
        this.#egLppEndpoints = new Map();
        this.#lpcEntityMap = new Map();
        this.#egLppStreams = [];
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
     */
    async distributeLimit(isActive, limitValue) {
        this.#currentLimitValue = limitValue;
        await this.#distributeLimit(isActive);
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
            const eebusGuards = this.#guards.filter(g => g instanceof EebusEnergyGuard);
            await resetManualLimits(eebusGuards, this.#adapter, this.#manualLimitTimers, callUnary);
        }
    }

    /**
     * Handle state changes for LPP Energy Guard states.
     *
     * @param {string} localId - Local state ID (e.g., "LPP.EnergyGuards.Guard_Inverter.percentage")
     * @param {ioBroker.State} state - State object (only ack=false writes are forwarded here)
     */
    async handleGuardStateChange(localId, state) {
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
                log.info(`LPP manual energy guard "${guardName}" heartbeat write received`);
                await guard.onHeartbeatWrite();
                if (this.#lastLimitActive) {
                    await this.#distributeLimit(true);
                }
            }
        } else if (stateName === 'connected') {
            if (guard instanceof ManualEnergyGuard) {
                log.info(`LPP manual energy guard "${guardName}" connected changed to ${state.val}`);
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
                try {
                    await guard.onFailsafeLimitWrite(newValue);
                    await this.#updateReportedFailsafe();
                    if (this.#lastLimitActive) {
                        await this.#distributeLimit(true);
                    }
                } catch (err) {
                    log.warn(`Failed to write failsafe limit for LPP guard "${guardName}": ${err.message}`);
                }
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

                try {
                    if (limitW > 0) {
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
                                    log.warn(
                                        `Failed to deactivate expired manual production limit for LPP guard "${guardName}": ${err.message}`,
                                    );
                                }
                                await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                            },
                            60 * 60 * 1000,
                        );
                        this.#manualLimitTimers.set(guardName, timer);
                    } else {
                        await callUnary(egLppClient, 'WriteProductionLimit', {
                            remote_ski: guard.ski,
                            remote_entity_address: { entity_address: guard.remoteEntityAddress || [] },
                            limit: { is_active: false, value: 0 },
                        });
                        log.info(`Manual production limit deactivated for LPP guard "${guardName}"`);
                        await this.#adapter.setStateAsync(`${guard.basePath}.manualLimit`, 0, true);
                    }
                } catch (err) {
                    log.warn(`Failed to write manual production limit for LPP guard "${guardName}": ${err.message}`);
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
                        log.error(`AddUseCase returned empty endpoint for LPP guard "${entry.name}" — skipping EG-LPP`);
                    }
                } catch (err) {
                    log.error(`Failed to add EG-LPP use case for guard "${entry.name}": ${err.message}`);
                }

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

        if (this.#egLppEndpoints.size > 0) {
            this.#subscribeEgLppEvents();
        }

        await this.#cleanupRemovedGuards(guardConfigs);
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

                if (eventName === 'UseCaseSupportUpdate') {
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
                    try {
                        await guard.handleHeartbeat();
                        log.silly(`LPP heartbeat received for guard "${guard.name}" (SKI=${ski})`);
                    } catch (err) {
                        log.warn(`Failed to handle LPP heartbeat for guard "${guard.name}": ${err.message}`);
                    }
                    if (this.#lastLimitActive) {
                        try {
                            await this.#distributeLimit(true);
                        } catch (err) {
                            log.warn(`Failed to re-distribute LPP limit after heartbeat: ${err.message}`);
                        }
                    }
                } else if (eventName === 'DataUpdateFailsafeProductionActivePowerLimit') {
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
                            await this.#updateReportedFailsafe();
                        }
                        if (this.#lastLimitActive) {
                            await this.#distributeLimit(true);
                        }
                    } catch (err) {
                        log.warn(`Failed to read LPP failsafe limit for guard "${guard.name}": ${err.message}`);
                    }
                } else if (eventName === 'DataUpdateLimit') {
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

    // ─── Internal: Limit Distribution ───────────────────────────────────

    async #distributeLimit(isActive) {
        const log = this.#adapter.log;
        log.info(`LPP distributeLimit called: isActive=${isActive}, guards=${this.#guards.length}`);
        this.#lastLimitActive = isActive;

        if (!isActive) {
            for (const guard of this.#guards) {
                try {
                    if (guard instanceof EebusEnergyGuard) {
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

        const totalLimit = this.#currentLimitValue;
        log.info(`LPP distributeLimit: using stored totalLimit=${totalLimit}`);

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

        const effectiveLimits = distributeProductionLimit(totalLimit, guardData);

        // Apply calculated limits to guards
        for (let i = 0; i < this.#guards.length; i++) {
            const guard = this.#guards[i];
            const limitInfo = effectiveLimits[i];
            try {
                if (limitInfo.skip) {
                    await this.#adapter.setStateAsync(`${guard.basePath}.currentLimit`, guard.failsafeLimit, true);
                } else if (guard instanceof EebusEnergyGuard) {
                    const effectiveLimit = limitInfo.effectiveLimit;
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
                    await guard.applyEffectiveLimit(limitInfo.effectiveLimit);
                }
            } catch (err) {
                log.warn(`Failed to apply LPP limit to guard "${guard.name}": ${err.message}`);
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
        try {
            await callUnary(this.#csLppClient, 'SetFailsafeProductionActivePowerLimit', {
                value: -failsafeSum,
                is_changeable: false,
            });
            this.#adapter.log.info(`LPP reported failsafe limit to controlbox: ${failsafeSum}W`);
        } catch (err) {
            this.#adapter.log.warn(`Failed to update LPP failsafe limit on controlbox: ${err.message}`);
        }
    }
}

module.exports = { EgLpp };
