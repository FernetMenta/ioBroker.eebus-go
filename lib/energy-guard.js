'use strict';

const { callUnary } = require('./grpc-client');

/**
 * Base class for all Energy Guard types.
 * Manages percentage-based limit calculation, ioBroker state objects,
 * and heartbeat tracking.
 *
 * @internal
 */
class BaseEnergyGuard {
    #adapter;
    #name;
    #translate;
    #currentLimit;
    #lastHeartbeat;
    #failsafeLimit;
    #basePath;
    #heartbeatTimer;
    #heartbeatTimeoutMs;
    #missedHeartbeats;

    /**
     * Create a new BaseEnergyGuard.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} name - Guard identifier (used in object path)
     * @param {number} heartbeatTimeoutSeconds - Heartbeat timeout in seconds
     * @param {(key: string) => string} translate - I18n translate function
     * @param {object} [options] - Optional configuration
     * @param {string} [options.pathPrefix] - Prefix for the ioBroker object path (e.g., "LPP" results in "LPP.EnergyGuards.Guard_{name}")
     */
    constructor(adapter, name, heartbeatTimeoutSeconds, translate, options) {
        this.#adapter = adapter;
        this.#name = name;
        this.#translate = translate || (key => key);
        this.#currentLimit = 0;
        this.#lastHeartbeat = 0;
        this.#failsafeLimit = 0;
        const prefix = options && options.pathPrefix ? `${options.pathPrefix}.` : '';
        this.#basePath = `${prefix}EnergyGuards.Guard_${BaseEnergyGuard.#name2id(name)}`;
        this.#heartbeatTimer = null;
        this.#heartbeatTimeoutMs = Math.min(Math.max(heartbeatTimeoutSeconds || 60, 5), 600) * 1000;
        this.#missedHeartbeats = 0;
    }

    /**
     * Sanitize a guard name for use in ioBroker object IDs.
     * Replaces all characters not allowed in object IDs with underscores.
     *
     * @param {string} name - The raw guard name from user input
     * @returns {string} Sanitized name safe for use in object IDs
     */
    static #name2id(name) {
        return (name || '').replace(/[^A-Za-z0-9\-_]/g, '_');
    }

    /**
     * The ioBroker adapter instance.
     *
     * @returns {object} adapter instance
     */
    get adapter() {
        return this.#adapter;
    }

    /**
     * The guard's name identifier.
     *
     * @returns {string} guard name
     */
    get name() {
        return this.#name;
    }

    /**
     * The ioBroker state path prefix for this guard.
     *
     * @returns {string} base path
     */
    get basePath() {
        return this.#basePath;
    }

    /**
     * The translate function for this guard.
     *
     * @returns {(key: string) => string} translate function
     */
    get translate() {
        return this.#translate;
    }

    /**
     * Create ioBroker state objects for this guard.
     * Uses extendObjectAsync to preserve existing customizations.
     */
    async createObjects() {
        await this.#adapter.extendObjectAsync(this.#basePath, {
            type: 'channel',
            common: { name: this.#name },
            native: {},
        });

        await this.#adapter.extendObjectAsync(`${this.#basePath}.percentage`, {
            type: 'state',
            common: {
                name: this.translate('Percentage'),
                type: 'number',
                role: 'level',
                min: 0,
                max: 100,
                def: 0,
                read: true,
                write: true,
            },
            native: {},
        });

        await this.#adapter.extendObjectAsync(`${this.#basePath}.currentLimit`, {
            type: 'state',
            common: {
                name: this.translate('Current Limit'),
                type: 'number',
                role: 'value.power',
                unit: 'W',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });

        await this.#adapter.extendObjectAsync(`${this.#basePath}.lastHeartbeat`, {
            type: 'state',
            common: {
                name: this.translate('Last Heartbeat'),
                type: 'number',
                role: 'date',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });

        await this.#adapter.extendObjectAsync(`${this.#basePath}.failsafeLimit`, {
            type: 'state',
            common: {
                name: this.translate('Failsafe Limit'),
                type: 'number',
                role: 'level',
                unit: 'W',
                def: 0,
                read: true,
                write: true,
            },
            native: {},
        });
    }

    /**
     * Calculate the effective limit as a pure function.
     * Returns the maximum of (effectivePct * totalLimit / 100) and the guard's failsafe limit.
     *
     * @param {number} totalLimit - The total power limit to distribute (controlbox limit value)
     * @param {number} effectivePct - The effective percentage after proportional scaling
     * @returns {number} The calculated limit in watts
     */
    calculateLimit(totalLimit, effectivePct) {
        return Math.max((effectivePct * totalLimit) / 100, this.#failsafeLimit);
    }

    /**
     * Apply a limit to this guard. Calculates the effective limit using the provided
     * effectivePct, stores the result, and updates ioBroker states.
     *
     * @param {number} totalLimit - The total power limit to distribute (controlbox limit value)
     * @param {number} effectivePct - The effective percentage after proportional scaling
     */
    async applyLimit(totalLimit, effectivePct) {
        this.#currentLimit = this.calculateLimit(totalLimit, effectivePct);

        await this.#adapter.setStateAsync(`${this.#basePath}.currentLimit`, this.#currentLimit, true);
    }

    /**
     * Apply a pre-calculated effective limit directly to this guard.
     * Used when the distribution algorithm has already computed the final limit value.
     *
     * @param {number} effectiveLimit - The final limit value in watts
     */
    async applyEffectiveLimit(effectiveLimit) {
        this.#currentLimit = effectiveLimit;

        await this.#adapter.setStateAsync(`${this.#basePath}.currentLimit`, this.#currentLimit, true);
    }

    /**
     * Deactivate the current limit on this guard.
     * Sets limitActive=false, currentLimit=0, and updates ioBroker states.
     */
    async deactivateLimit() {
        this.#currentLimit = 0;

        await this.#adapter.setStateAsync(`${this.#basePath}.currentLimit`, 0, true);
    }

    /**
     * Read the current percentage from the ioBroker state object.
     * Returns 0 if the state is unreadable.
     *
     * @returns {Promise<number>} The percentage value (0–100)
     */
    async getPercentage() {
        try {
            const state = await this.#adapter.getStateAsync(`${this.#basePath}.percentage`);
            if (state && state.val != null) {
                return Number(state.val);
            }
        } catch {
            // Default to 0 if unreadable
        }
        return 0;
    }

    /**
     * The current calculated limit value in watts.
     *
     * @returns {number} current limit value
     */
    get currentLimit() {
        return this.#currentLimit;
    }

    /**
     * The current failsafe limit value in watts (floor for limit calculation).
     *
     * @returns {number} failsafe limit value
     */
    get failsafeLimit() {
        return this.#failsafeLimit;
    }

    /**
     * Set the failsafe limit value and update the ioBroker state.
     * Returns true if the value changed, false if unchanged.
     *
     * @param {number} value - The failsafe limit in watts
     * @returns {Promise<boolean>} true if value changed
     */
    async setFailsafeLimit(value) {
        if (this.#failsafeLimit === value) {
            return false;
        }
        this.#failsafeLimit = value;
        await this.#adapter.setStateAsync(`${this.#basePath}.failsafeLimit`, value, true);
        return true;
    }

    /**
     * Record a heartbeat with the current timestamp and update the ioBroker state.
     */
    async updateHeartbeat() {
        this.#lastHeartbeat = Date.now();
        await this.#adapter.setStateAsync(`${this.#basePath}.lastHeartbeat`, this.#lastHeartbeat, true);
    }

    /**
     * Reset the heartbeat timeout timer.
     * Resets the missed-heartbeat counter so that 2 consecutive misses
     * are required before `onHeartbeatTimeout()` is called.
     */
    resetHeartbeatTimer() {
        this.#missedHeartbeats = 0;
        if (this.#heartbeatTimer) {
            this.#adapter.clearTimeout(this.#heartbeatTimer);
        }
        this.#heartbeatTimer = this.#adapter.setTimeout(async () => {
            await this.#handleHeartbeatMiss();
        }, this.#heartbeatTimeoutMs);
    }

    /**
     * Internal: called on each timer expiry. Increments the miss counter
     * and only triggers `onHeartbeatTimeout()` after 2 consecutive misses.
     */
    async #handleHeartbeatMiss() {
        this.#missedHeartbeats++;
        if (this.#missedHeartbeats >= 2) {
            await this.onHeartbeatTimeout();
        } else {
            // Schedule one more interval before declaring timeout
            this.#heartbeatTimer = this.#adapter.setTimeout(async () => {
                await this.#handleHeartbeatMiss();
            }, this.#heartbeatTimeoutMs);
        }
    }

    /**
     * Clear the heartbeat timeout timer.
     */
    clearHeartbeatTimer() {
        if (this.#heartbeatTimer) {
            this.#adapter.clearTimeout(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
        }
        this.#missedHeartbeats = 0;
    }

    /**
     * Called when the heartbeat timeout expires.
     * Subclasses must override to define timeout behavior.
     */
    async onHeartbeatTimeout() {
        // Override in subclasses
    }
}

/**
 * EEBUS-type Energy Guard that communicates with a paired Controllable System
 * via the EG-LPC use case over gRPC.
 */
class EebusEnergyGuard extends BaseEnergyGuard {
    #ski;
    #egLpcClient;
    #instanceId;
    #connected;
    #heartbeatReceived;
    #remoteSki;
    #remoteEntityAddress;
    #manualLimitTimer;

    /**
     * Create a new EebusEnergyGuard.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} name - Guard identifier (used in object path)
     * @param {string} ski - Subject Key Identifier of the paired device
     * @param {number} heartbeatTimeoutSeconds - Heartbeat timeout in seconds
     * @param {(key: string) => string} translate - I18n translate function
     * @param {object} [options] - Optional configuration
     * @param {string} [options.pathPrefix] - Prefix for the ioBroker object path (e.g., "LPP")
     */
    constructor(adapter, name, ski, heartbeatTimeoutSeconds, translate, options) {
        super(adapter, name, heartbeatTimeoutSeconds, translate, options);
        this.#ski = ski;
        this.#egLpcClient = null;
        this.#instanceId = null;
        this.#connected = false;
        this.#heartbeatReceived = false;
        this.#remoteSki = null;
        this.#remoteEntityAddress = null;
        this.#manualLimitTimer = null;
    }

    /**
     * The configured SKI for this guard.
     *
     * @returns {string} SKI value
     */
    get ski() {
        return this.#ski;
    }

    /**
     * The EG-LPC gRPC client for this guard (null if not paired).
     *
     * @returns {object|null} gRPC client instance
     */
    get egLpcClient() {
        return this.#egLpcClient;
    }

    /**
     * The instance ID for routing gRPC calls to this use case instance.
     *
     * @returns {string|null} Instance ID
     */
    get instanceId() {
        return this.#instanceId;
    }

    /**
     * Create ioBroker state objects for this EEBUS guard.
     * Adds the eebusConnected and manualLimit states on top of the base objects.
     */
    async createObjects() {
        await super.createObjects();

        await this.adapter.extendObjectAsync(`${this.basePath}.eebusConnected`, {
            type: 'state',
            common: {
                name: this.translate('EEBUS Connected'),
                type: 'boolean',
                role: 'indicator.connected',
                def: false,
                read: true,
                write: false,
            },
            native: {},
        });

        await this.adapter.extendObjectAsync(`${this.basePath}.manualLimit`, {
            type: 'state',
            common: {
                name: this.translate('Manual Limit'),
                type: 'number',
                role: 'level',
                unit: 'W',
                def: 0,
                min: 0,
                read: true,
                write: true,
            },
            native: {},
        });

        await this.adapter.extendObjectAsync(`${this.basePath}.confirmedLimit`, {
            type: 'state',
            common: {
                name: this.translate('Confirmed Limit'),
                type: 'number',
                role: 'value.power',
                unit: 'W',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });

        await this.adapter.extendObjectAsync(`${this.basePath}.nominalMax`, {
            type: 'state',
            common: {
                name: this.translate('Nominal Max Power'),
                type: 'number',
                role: 'value.power',
                unit: 'W',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });

        await this.adapter.extendObjectAsync(`${this.basePath}.failsafeDuration`, {
            type: 'state',
            common: {
                name: this.translate('Failsafe Duration'),
                type: 'number',
                role: 'level',
                unit: 's',
                def: 0,
                read: true,
                write: true,
            },
            native: {},
        });
    }

    /**
     * Called when the user writes a failsafe limit value (watts) to the failsafeLimit state.
     * Sends the appropriate WriteFailsafe RPC to the remote device via gRPC.
     * On success, updates the internal failsafe limit and acknowledges the write.
     *
     * @param {number} value - Failsafe power limit in watts
     */
    async onFailsafeLimitWrite(value) {
        const limitW = Number(value) || 0;

        if (!this.#egLpcClient || !this.#connected || !this.#remoteSki) {
            this.adapter.log.warn(`Cannot write failsafe limit for guard "${this.name}" — not connected`);
            return;
        }

        const rpcName = this.basePath.startsWith('LPP.')
            ? 'WriteFailsafeProductionActivePowerLimit'
            : 'WriteFailsafeConsumptionActivePowerLimit';

        await callUnary(this.#egLpcClient, rpcName, {
            instance_id: this.#instanceId,
            remote_ski: this.#remoteSki,
            remote_entity_address: { entity_address: this.#remoteEntityAddress },
            limit: limitW,
        });

        // Do not update internal state here. The remote device will send a
        // DataUpdateFailsafe event if it accepts the new value, which the
        // event handler will use to update the state. This prevents reporting
        // an unconfirmed failsafe limit to the controlbox.
        this.adapter.log.info(`Failsafe limit ${limitW}W write sent to guard "${this.name}" — awaiting confirmation`);
    }

    /**
     * Called when the user writes a failsafe duration value (seconds) to the failsafeDuration state.
     * Sends WriteFailsafeDurationMinimum to the remote device via gRPC.
     * On success, acknowledges the write.
     *
     * @param {number} value - Failsafe duration in seconds
     */
    async onFailsafeDurationWrite(value) {
        const durationS = Number(value) || 0;

        if (!this.#egLpcClient || !this.#connected || !this.#remoteSki) {
            this.adapter.log.warn(`Cannot write failsafe duration for guard "${this.name}" — not connected`);
            return;
        }

        const durationNs = durationS * 1_000_000_000;

        await callUnary(this.#egLpcClient, 'WriteFailsafeDurationMinimum', {
            instance_id: this.#instanceId,
            remote_ski: this.#remoteSki,
            remote_entity_address: { entity_address: this.#remoteEntityAddress },
            duration_nanoseconds: durationNs,
        });

        await this.adapter.setStateAsync(`${this.basePath}.failsafeDuration`, durationS, true);
        this.adapter.log.info(`Failsafe duration ${durationS}s written to guard "${this.name}"`);
    }

    /**
     * Returns the correct gRPC RPC name for writing limits based on whether
     * this guard is used for LPC (consumption) or LPP (production).
     *
     * @returns {string} RPC method name
     */
    get #writeLimitRpc() {
        return this.basePath.startsWith('LPP.') ? 'WriteProductionLimit' : 'WriteConsumptionLimit';
    }

    /**
     * Apply a limit to this guard. Calls the base implementation and additionally
     * sends the limit write via gRPC if paired.
     *
     * @param {number} totalLimit - The total power limit to distribute (controlbox limit value)
     * @param {number} effectivePct - The effective percentage after proportional scaling
     */
    async applyLimit(totalLimit, effectivePct) {
        await super.applyLimit(totalLimit, effectivePct);

        if (this.#egLpcClient && this.#connected && this.#remoteSki) {
            const limit = this.calculateLimit(totalLimit, effectivePct);
            await callUnary(this.#egLpcClient, this.#writeLimitRpc, {
                instance_id: this.#instanceId,
                remote_ski: this.#remoteSki,
                remote_entity_address: { entity_address: this.#remoteEntityAddress },
                limit: {
                    is_active: true,
                    value: limit,
                },
            });
        }
    }

    /**
     * Apply a pre-calculated effective limit to this guard. Calls the base implementation
     * and additionally sends the limit write via gRPC if paired.
     *
     * @param {number} effectiveLimit - The final limit value in watts
     */
    async applyEffectiveLimit(effectiveLimit) {
        await super.applyEffectiveLimit(effectiveLimit);

        if (this.#egLpcClient && this.#connected && this.#remoteSki) {
            await callUnary(this.#egLpcClient, this.#writeLimitRpc, {
                instance_id: this.#instanceId,
                remote_ski: this.#remoteSki,
                remote_entity_address: { entity_address: this.#remoteEntityAddress },
                limit: {
                    is_active: true,
                    value: effectiveLimit,
                },
            });
        }
    }

    /**
     * Deactivate the limit on this guard. Calls the base implementation and additionally
     * sends deactivation via gRPC if paired.
     */
    async deactivateLimit() {
        await super.deactivateLimit();

        if (this.#egLpcClient && this.#connected && this.#remoteSki) {
            await callUnary(this.#egLpcClient, this.#writeLimitRpc, {
                instance_id: this.#instanceId,
                remote_ski: this.#remoteSki,
                remote_entity_address: { entity_address: this.#remoteEntityAddress },
                limit: {
                    is_active: false,
                    value: 0,
                },
            });
        }
    }

    /**
     * Assign the EG-LPC gRPC client after pairing with a remote device.
     *
     * @param {object} client - The EG-LPC gRPC client instance
     * @param {string} instanceId - The use case instance ID for routing
     * @param {string} remoteSki - The remote device's SKI
     * @param {number[]} remoteEntityAddress - The remote device's entity address
     */
    async assignUseCaseClient(client, instanceId, remoteSki, remoteEntityAddress) {
        this.#egLpcClient = client;
        this.#instanceId = instanceId;
        this.#remoteSki = remoteSki;
        this.#remoteEntityAddress = remoteEntityAddress;

        // Clear any active manual limit timer and reset state
        if (this.#manualLimitTimer) {
            this.adapter.clearTimeout(this.#manualLimitTimer);
            this.#manualLimitTimer = null;
        }
        await this.adapter.setStateAsync(`${this.basePath}.manualLimit`, 0, true);

        // Start the EG heartbeat so the remote CS can subscribe to it and
        // detect when the EG disconnects (enters failsafe on communication loss).
        await callUnary(client, 'StartHeartbeat', { instance_id: instanceId });

        // Mark as connected on assignment. UseCaseSupportUpdate confirms the
        // remote device is paired and reachable. Some devices (e.g. PLENTICORE)
        // do not support heartbeat subscriptions, so we cannot rely solely on
        // DataUpdateHeartbeat events to set the connection state.
        this.#heartbeatReceived = true;
        await this.setConnected(true);
        this.resetHeartbeatTimer();
    }

    /**
     * Unassign the EG-LPC gRPC client.
     * Sets client to null, resets heartbeat state, clears timer, and marks as disconnected.
     */
    async unassignUseCaseClient() {
        if (this.#egLpcClient) {
            this.#egLpcClient.close();
        }
        this.#egLpcClient = null;
        this.#heartbeatReceived = false;
        this.#remoteSki = null;
        this.#remoteEntityAddress = null;
        if (this.#manualLimitTimer) {
            this.adapter.clearTimeout(this.#manualLimitTimer);
            this.#manualLimitTimer = null;
        }
        this.clearHeartbeatTimer();
        await this.setConnected(false);
    }

    /**
     * Handle a heartbeat event from the paired device.
     * Records the heartbeat timestamp, marks heartbeat as received,
     * updates the connection state, and resets the heartbeat timeout timer.
     */
    async handleHeartbeat() {
        this.#heartbeatReceived = true;
        await this.updateHeartbeat();
        await this.setConnected(true);
        this.resetHeartbeatTimer();
    }

    /**
     * Called when the heartbeat timeout expires.
     * Unbinds the use case client so the guard waits for reconnection.
     */
    async onHeartbeatTimeout() {
        this.adapter.log.warn(`Heartbeat timeout for EEBUS guard "${this.name}" — unbinding use case client`);
        await this.unassignUseCaseClient();
    }

    /**
     * Called when the user writes a manual limit value (watts) to the manualLimit state.
     * Sends the limit write RPC with a 60-minute duration if value > 0,
     * or deactivates if value is 0.
     *
     * @param {number} value - Power limit in watts (0 = deactivate)
     */
    async onManualLimitWrite(value) {
        const limitW = Number(value) || 0;

        // Clear any existing manual limit timer
        if (this.#manualLimitTimer) {
            this.adapter.clearTimeout(this.#manualLimitTimer);
            this.#manualLimitTimer = null;
        }

        if (!this.#egLpcClient || !this.#connected || !this.#remoteSki) {
            this.adapter.log.warn(`Cannot write manual limit for guard "${this.name}" — not connected`);
            return;
        }

        if (limitW > 0) {
            // Send active limit with 60-minute duration
            const durationNs = 60 * 60 * 1_000_000_000; // 60 minutes in nanoseconds
            await callUnary(this.#egLpcClient, this.#writeLimitRpc, {
                instance_id: this.#instanceId,
                remote_ski: this.#remoteSki,
                remote_entity_address: { entity_address: this.#remoteEntityAddress },
                limit: {
                    is_active: true,
                    value: limitW,
                    duration_nanoseconds: durationNs,
                },
            });
            this.adapter.log.info(`Manual limit ${limitW}W sent to guard "${this.name}" (duration: 60min)`);

            // Start timer to deactivate after 60 minutes
            this.#manualLimitTimer = this.adapter.setTimeout(
                async () => {
                    this.#manualLimitTimer = null;
                    this.adapter.log.info(`Manual limit duration expired for guard "${this.name}" — deactivating`);
                    try {
                        if (this.#egLpcClient && this.#connected && this.#remoteSki) {
                            await callUnary(this.#egLpcClient, this.#writeLimitRpc, {
                                instance_id: this.#instanceId,
                                remote_ski: this.#remoteSki,
                                remote_entity_address: { entity_address: this.#remoteEntityAddress },
                                limit: {
                                    is_active: false,
                                    value: 0,
                                },
                            });
                        }
                    } catch (err) {
                        this.adapter.log.warn(
                            `Failed to deactivate expired manual limit for guard "${this.name}": ${err.message}`,
                        );
                    }
                    await this.adapter.setStateAsync(`${this.basePath}.manualLimit`, 0, true);
                },
                60 * 60 * 1000,
            ); // 60 minutes
        } else {
            // Deactivate
            await callUnary(this.#egLpcClient, this.#writeLimitRpc, {
                instance_id: this.#instanceId,
                remote_ski: this.#remoteSki,
                remote_entity_address: { entity_address: this.#remoteEntityAddress },
                limit: {
                    is_active: false,
                    value: 0,
                },
            });
            this.adapter.log.info(`Manual limit deactivated for guard "${this.name}"`);
        }
    }

    /**
     * Update the EEBUS connection state.
     * Setting to true only takes effect if at least one heartbeat has been received.
     * Setting to false is always allowed.
     *
     * @param {boolean} value - The desired connection state
     */
    async setConnected(value) {
        if (value && !this.#heartbeatReceived) {
            return;
        }
        if (this.#connected === value) {
            return; // no change
        }
        this.#connected = value;
        await this.adapter.setStateAsync(`${this.basePath}.eebusConnected`, value, true);
    }

    /**
     * Returns the current connection state of this EEBUS guard.
     *
     * @returns {boolean} true if connected
     */
    isConnected() {
        return this.#connected;
    }

    /**
     * Get the remote entity address for this guard (set during assignUseCaseClient).
     *
     * @returns {number[]|null} The remote entity address or null if not connected
     */
    get remoteEntityAddress() {
        return this.#remoteEntityAddress;
    }
}

/**
 * Manual-type Energy Guard controlled by ioBroker user scripts
 * via writable heartbeat and connected state objects.
 */
class ManualEnergyGuard extends BaseEnergyGuard {
    #connected;

    /**
     * Create a new ManualEnergyGuard.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} name - Guard identifier (used in object path)
     * @param {number} heartbeatTimeoutSeconds - Heartbeat timeout in seconds
     * @param {(key: string) => string} translate - I18n translate function
     * @param {object} [options] - Optional configuration
     * @param {string} [options.pathPrefix] - Prefix for the ioBroker object path (e.g., "LPP")
     */
    constructor(adapter, name, heartbeatTimeoutSeconds, translate, options) {
        super(adapter, name, heartbeatTimeoutSeconds, translate, options);
        this.#connected = false;
    }

    /**
     * Create ioBroker state objects for this manual guard.
     * Adds writable heartbeat and connected states on top of the base objects.
     */
    async createObjects() {
        await super.createObjects();

        await this.adapter.extendObjectAsync(`${this.basePath}.heartbeat`, {
            type: 'state',
            common: {
                name: this.translate('Heartbeat'),
                type: 'boolean',
                role: 'button',
                def: false,
                read: false,
                write: true,
            },
            native: {},
        });

        await this.adapter.extendObjectAsync(`${this.basePath}.connected`, {
            type: 'state',
            common: {
                name: this.translate('Connected'),
                type: 'boolean',
                role: 'indicator.connected',
                def: false,
                read: true,
                write: false,
            },
            native: {},
        });
    }

    /**
     * Called when a user script writes to the heartbeat state.
     * Triggers a heartbeat timestamp update, marks as connected,
     * and resets the heartbeat timeout timer.
     */
    async onHeartbeatWrite() {
        await this.updateHeartbeat();

        // Mark as connected on heartbeat
        if (!this.#connected) {
            this.#connected = true;
            await this.adapter.setStateAsync(`${this.basePath}.connected`, true, true);
            this.adapter.log.info(`Manual energy guard "${this.name}" reconnected via heartbeat`);
        }

        // Reset the heartbeat timeout timer
        this.resetHeartbeatTimer();
    }

    /**
     * Called when the heartbeat timeout expires.
     * Marks the manual guard as disconnected.
     */
    async onHeartbeatTimeout() {
        this.adapter.log.warn(`Heartbeat timeout for manual guard "${this.name}" — marking disconnected`);
        this.#connected = false;
        await this.adapter.setStateAsync(`${this.basePath}.connected`, false, true);
    }

    /**
     * Called when a user script writes to the connected state.
     * Updates the internal connection state.
     *
     * @param {boolean} value - The new connection state
     */
    async onConnectedWrite(value) {
        this.#connected = !!value;
        await this.adapter.setStateAsync(`${this.basePath}.connected`, this.#connected, true);
    }

    /**
     * Called when a user script writes to the failsafeLimit state.
     * Updates the guard's failsafe limit value.
     *
     * @param {number} value - The new failsafe limit in watts
     */
    async onFailsafeLimitWrite(value) {
        await this.setFailsafeLimit(Number(value) || 0);
    }

    /**
     * Returns the current connection state of this manual guard.
     *
     * @returns {boolean} true if connected
     */
    isConnected() {
        return this.#connected;
    }
}

module.exports = { EebusEnergyGuard, ManualEnergyGuard };
