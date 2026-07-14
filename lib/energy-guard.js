'use strict';

const { callUnary } = require('./grpc');

/**
 * Module-level translate function. Set via `setI18n()` after `I18n.init()` is called.
 * Falls back to returning the key as-is if not initialized.
 */
let translate = key => key;

/**
 * Set the translate function (called from hems.js after I18n.init).
 *
 * @param {Function} fn - The I18n.translate function
 */
function setI18n(fn) {
    translate = fn;
}

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
    #currentLimit;
    #limitActive;
    #lastHeartbeat;
    #failsafeLimit;
    #basePath;
    #heartbeatTimer;
    #heartbeatTimeoutMs;

    /**
     * Create a new BaseEnergyGuard.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} name - Guard identifier (used in object path)
     * @param {number} heartbeatTimeoutSeconds - Heartbeat timeout in seconds
     */
    constructor(adapter, name, heartbeatTimeoutSeconds) {
        this.#adapter = adapter;
        this.#name = name;
        this.#currentLimit = 0;
        this.#limitActive = false;
        this.#lastHeartbeat = 0;
        this.#failsafeLimit = 0;
        this.#basePath = `EnergyGuards.Guard_${name}`;
        this.#heartbeatTimer = null;
        this.#heartbeatTimeoutMs = (heartbeatTimeoutSeconds || 60) * 1000;
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
                name: translate('Percentage'),
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
                name: translate('Current Limit'),
                type: 'number',
                role: 'value.power',
                unit: 'W',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });

        await this.#adapter.extendObjectAsync(`${this.#basePath}.limitActive`, {
            type: 'state',
            common: {
                name: translate('Limit Active'),
                type: 'boolean',
                role: 'indicator',
                def: false,
                read: true,
                write: false,
            },
            native: {},
        });

        await this.#adapter.extendObjectAsync(`${this.#basePath}.lastHeartbeat`, {
            type: 'state',
            common: {
                name: translate('Last Heartbeat'),
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
                name: translate('Failsafe Limit'),
                type: 'number',
                role: 'value.power',
                unit: 'W',
                def: 0,
                read: true,
                write: false,
            },
            native: {},
        });
    }

    /**
     * Calculate the effective limit as a pure function.
     * Returns the maximum of (effectivePct * contractMax / 100) and the guard's failsafe limit.
     *
     * @param {number} contractMax - The contract maximum power (consumptionNominalMax)
     * @param {number} effectivePct - The effective percentage after proportional scaling
     * @returns {number} The calculated limit in watts
     */
    calculateLimit(contractMax, effectivePct) {
        return Math.max((effectivePct * contractMax) / 100, this.#failsafeLimit);
    }

    /**
     * Apply a limit to this guard. Calculates the effective limit using the provided
     * effectivePct, stores the result, and updates ioBroker states.
     *
     * @param {number} contractMax - The contract maximum power (consumptionNominalMax)
     * @param {number} effectivePct - The effective percentage after proportional scaling
     */
    async applyLimit(contractMax, effectivePct) {
        this.#currentLimit = this.calculateLimit(contractMax, effectivePct);
        this.#limitActive = true;

        await this.#adapter.setStateAsync(`${this.#basePath}.currentLimit`, this.#currentLimit, true);
        await this.#adapter.setStateAsync(`${this.#basePath}.limitActive`, true, true);
    }

    /**
     * Deactivate the current limit on this guard.
     * Sets limitActive=false, currentLimit=0, and updates ioBroker states.
     */
    async deactivateLimit() {
        this.#limitActive = false;
        this.#currentLimit = 0;

        await this.#adapter.setStateAsync(`${this.#basePath}.currentLimit`, 0, true);
        await this.#adapter.setStateAsync(`${this.#basePath}.limitActive`, false, true);
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
     * Whether a limit is currently active on this guard.
     *
     * @returns {boolean} true if a limit is active
     */
    get limitActive() {
        return this.#limitActive;
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
     *
     * @param {number} value - The failsafe limit in watts
     */
    async setFailsafeLimit(value) {
        this.#failsafeLimit = value;
        await this.#adapter.setStateAsync(`${this.#basePath}.failsafeLimit`, value, true);
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
     * Subclasses should override `onHeartbeatTimeout()` to define timeout behavior.
     */
    resetHeartbeatTimer() {
        if (this.#heartbeatTimer) {
            clearTimeout(this.#heartbeatTimer);
        }
        this.#heartbeatTimer = setTimeout(async () => {
            await this.onHeartbeatTimeout();
        }, this.#heartbeatTimeoutMs);
    }

    /**
     * Clear the heartbeat timeout timer.
     */
    clearHeartbeatTimer() {
        if (this.#heartbeatTimer) {
            clearTimeout(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
        }
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
    #connected;
    #heartbeatReceived;
    #remoteSki;
    #remoteEntityAddress;

    /**
     * Create a new EebusEnergyGuard.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} name - Guard identifier (used in object path)
     * @param {string} ski - Subject Key Identifier of the paired device
     * @param {number} heartbeatTimeoutSeconds - Heartbeat timeout in seconds
     */
    constructor(adapter, name, ski, heartbeatTimeoutSeconds) {
        super(adapter, name, heartbeatTimeoutSeconds);
        this.#ski = ski;
        this.#egLpcClient = null;
        this.#connected = false;
        this.#heartbeatReceived = false;
        this.#remoteSki = null;
        this.#remoteEntityAddress = null;
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
     * Create ioBroker state objects for this EEBUS guard.
     * Adds the eebusConnected state on top of the base objects.
     */
    async createObjects() {
        await super.createObjects();

        await this.adapter.extendObjectAsync(`${this.basePath}.eebusConnected`, {
            type: 'state',
            common: {
                name: translate('EEBUS Connected'),
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
     * Apply a limit to this guard. Calls the base implementation and additionally
     * sends WriteConsumptionLimit via gRPC if paired.
     *
     * @param {number} contractMax - The contract maximum power (consumptionNominalMax)
     * @param {number} effectivePct - The effective percentage after proportional scaling
     */
    async applyLimit(contractMax, effectivePct) {
        await super.applyLimit(contractMax, effectivePct);

        if (this.#egLpcClient && this.#connected && this.#remoteSki) {
            const limit = this.calculateLimit(contractMax, effectivePct);
            await callUnary(this.#egLpcClient, 'WriteConsumptionLimit', {
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
     * Deactivate the limit on this guard. Calls the base implementation and additionally
     * sends deactivation via gRPC if paired.
     */
    async deactivateLimit() {
        await super.deactivateLimit();

        if (this.#egLpcClient && this.#connected && this.#remoteSki) {
            await callUnary(this.#egLpcClient, 'WriteConsumptionLimit', {
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
     * @param {string} remoteSki - The remote device's SKI
     * @param {number[]} remoteEntityAddress - The remote device's entity address
     */
    assignUseCaseClient(client, remoteSki, remoteEntityAddress) {
        this.#egLpcClient = client;
        this.#remoteSki = remoteSki;
        this.#remoteEntityAddress = remoteEntityAddress;
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
     */
    constructor(adapter, name, heartbeatTimeoutSeconds) {
        super(adapter, name, heartbeatTimeoutSeconds);
        this.#connected = false;
    }

    /**
     * Create ioBroker state objects for this manual guard.
     * Adds writable heartbeat and connected states on top of the base objects.
     * Overrides failsafeLimit to be writable for manual guards.
     */
    async createObjects() {
        await super.createObjects();

        // Override failsafeLimit to be writable for manual guards
        await this.adapter.extendObjectAsync(`${this.basePath}.failsafeLimit`, {
            type: 'state',
            common: {
                name: translate('Failsafe Limit'),
                type: 'number',
                role: 'value.power',
                unit: 'W',
                def: 0,
                read: true,
                write: true,
            },
            native: {},
        });

        await this.adapter.extendObjectAsync(`${this.basePath}.heartbeat`, {
            type: 'state',
            common: {
                name: translate('Heartbeat'),
                type: 'boolean',
                role: 'button',
                def: false,
                read: true,
                write: true,
            },
            native: {},
        });

        await this.adapter.extendObjectAsync(`${this.basePath}.connected`, {
            type: 'state',
            common: {
                name: translate('Connected'),
                type: 'boolean',
                role: 'indicator.connected',
                def: false,
                read: true,
                write: true,
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

module.exports = { EebusEnergyGuard, ManualEnergyGuard, setI18n };
