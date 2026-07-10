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

    /**
     * Create a new BaseEnergyGuard.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} name - Guard identifier (used in object path)
     */
    constructor(adapter, name) {
        this.#adapter = adapter;
        this.#name = name;
        this.#currentLimit = 0;
        this.#limitActive = false;
        this.#lastHeartbeat = 0;
        this.#failsafeLimit = 0;
        this.#basePath = `EnergyGuards.Guard_${name}`;
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

    /**
     * Create a new EebusEnergyGuard.
     *
     * @param {object} adapter - ioBroker adapter instance
     * @param {string} name - Guard identifier (used in object path)
     * @param {string} ski - Subject Key Identifier of the paired device
     */
    constructor(adapter, name, ski) {
        super(adapter, name);
        this.#ski = ski;
        this.#egLpcClient = null;
        this.#connected = false;
        this.#heartbeatReceived = false;
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

        if (this.#egLpcClient) {
            const limit = this.calculateLimit(contractMax, effectivePct);
            await callUnary(this.#egLpcClient, 'WriteConsumptionLimit', {
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

        if (this.#egLpcClient) {
            await callUnary(this.#egLpcClient, 'WriteConsumptionLimit', {
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
     */
    assignUseCaseClient(client) {
        this.#egLpcClient = client;
    }

    /**
     * Unassign the EG-LPC gRPC client.
     * Sets client to null, resets heartbeat state, and marks as disconnected.
     */
    async unassignUseCaseClient() {
        this.#egLpcClient = null;
        this.#heartbeatReceived = false;
        await this.setConnected(false);
    }

    /**
     * Handle a heartbeat event from the paired device.
     * Records the heartbeat timestamp, marks heartbeat as received,
     * and updates the connection state.
     */
    async handleHeartbeat() {
        this.#heartbeatReceived = true;
        await this.updateHeartbeat();
        await this.setConnected(true);
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
     */
    constructor(adapter, name) {
        super(adapter, name);
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
     * Triggers a heartbeat timestamp update.
     */
    async onHeartbeatWrite() {
        await this.updateHeartbeat();
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
