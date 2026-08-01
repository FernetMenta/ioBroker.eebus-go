'use strict';

const path = require('node:path');
const { makeClient, callUnary } = require('./grpc-cslpc');
const { resetService, setConfig, startSetup, registerRemoteSki, startService } = require('./grpc-service');
const { LpcUseCase } = require('./lpc-use-case');
const { LppUseCase } = require('./lpp-use-case');
const { migrate } = require('./migration');

/**
 * Root directory for protobuf definitions.
 */
const PROTO_DIR = path.join(__dirname, 'protobuf');

/**
 * HEMS coordinator class.
 *
 * Responsibilities (shared concerns):
 *  - gRPC control client creation
 *  - EEBUS service configuration (SKI, device config, service port)
 *  - Discovery event stream management
 *  - info.connection, info.discoveredDevices, info.ski state management
 *  - Instantiation and lifecycle of LpcUseCase and LppUseCase based on config
 *  - Routing state changes to the correct use case instance
 *
 * Use-case-specific logic (FSM, CS clients, EG handling, limit distribution)
 * is fully delegated to the respective LpcUseCase / LppUseCase instances.
 */
class Hems {
    #adapter;
    #config;
    #controlClient;
    #discoveryStream;
    #discoveredDevices;
    #retryTimer;
    #translate;
    #lpcUseCase;
    #lppUseCase;

    /**
     * Create a new HEMS instance.
     *
     * @param {object} adapter - ioBroker adapter instance (provides config, log, setState, etc.)
     * @param {(key: string) => string} translate - I18n translate function
     */
    constructor(adapter, translate) {
        this.#adapter = adapter;
        this.#config = adapter.config;
        this.#translate = translate || (key => key);
        this.#controlClient = null;
        this.#discoveryStream = null;
        this.#discoveredDevices = new Map();
        this.#retryTimer = null;
        this.#lpcUseCase = null;
        this.#lppUseCase = null;
    }

    // ─── Public Interface ────────────────────────────────────────────────

    /**
     * Current state of the LPC FSM (for backward compatibility).
     * Returns the LPC use case state if enabled, otherwise 'init'.
     *
     * @returns {string} One of the LPC STATE constants or 'init'
     */
    get state() {
        if (this.#lpcUseCase) {
            return this.#lpcUseCase.state;
        }
        return 'init';
    }

    /**
     * Access the LPC use case instance (for testing).
     *
     * @returns {LpcUseCase|null} The LPC use case instance or null if not enabled
     */
    get lpcUseCase() {
        return this.#lpcUseCase;
    }

    /**
     * Access the LPP use case instance (for testing).
     *
     * @returns {LppUseCase|null} The LPP use case instance or null if not enabled
     */
    get lppUseCase() {
        return this.#lppUseCase;
    }

    /**
     * Trigger: Restart of the HEMS coordinator.
     * Sets up the gRPC control client, configures the service,
     * and starts enabled use case instances.
     */
    restart() {
        this.#onRestart();
    }

    /**
     * Stop the HEMS instance, cleaning up all resources.
     * Must be called from adapter onUnload.
     */
    stop() {
        // Stop use case instances
        if (this.#lpcUseCase) {
            this.#lpcUseCase.stop();
            this.#lpcUseCase = null;
        }
        if (this.#lppUseCase) {
            this.#lppUseCase.stop();
            this.#lppUseCase = null;
        }

        // Cancel retry timer
        if (this.#retryTimer) {
            this.#adapter.clearTimeout(this.#retryTimer);
            this.#retryTimer = null;
        }

        // Cancel discovery stream
        if (this.#discoveryStream) {
            this.#discoveryStream.cancel();
            this.#discoveryStream = null;
        }

        // Close control client
        if (this.#controlClient && this.#controlClient.close) {
            this.#controlClient.close();
            this.#controlClient = null;
        }
    }

    /**
     * Handle state changes for Energy Guard states.
     * Routes to the correct use case based on the state path prefix.
     *
     * Routing rules:
     *  - If id contains "LPC." → route to lpcUseCase.handleGuardStateChange()
     *  - If id contains "LPP." → route to lppUseCase.handleGuardStateChange()
     *
     * @param {string} id - Full state ID (e.g., "eebus-go.0.LPC.EnergyGuards.Guard_WallBox.percentage")
     * @param {ioBroker.State} state - State object (only ack=false writes are forwarded here)
     */
    async handleEnergyGuardStateChange(id, state) {
        const log = this.#adapter.log;
        const namespace = this.#adapter.namespace;
        const localId = id.startsWith(`${namespace}.`) ? id.slice(namespace.length + 1) : id;

        if (localId.startsWith('LPC.')) {
            if (this.#lpcUseCase) {
                await this.#lpcUseCase.handleGuardStateChange(localId, state);
            } else {
                log.debug(`LPC state change received but LPC use case not active: ${localId}`);
            }
        } else if (localId.startsWith('LPP.')) {
            if (this.#lppUseCase) {
                await this.#lppUseCase.handleGuardStateChange(localId, state);
            } else {
                log.debug(`LPP state change received but LPP use case not active: ${localId}`);
            }
        } else {
            log.debug(`Unrecognized state change path — no use case to route to: ${localId}`);
        }
    }

    // ─── Internal: Startup & Connection ─────────────────────────────────

    /**
     * Internal handler for restart.
     * Sets up the control client, configures the service, starts use cases.
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
            this.#adapter.clearTimeout(this.#retryTimer);
            this.#retryTimer = null;
        }

        try {
            await this.#connect();
        } catch (err) {
            log.warn(`gRPC connection failed: ${err.message} — retrying in 10s`);
            this.#adapter.setState('info.connection', false, true);
            this.#retryTimer = this.#adapter.setTimeout(() => this.#onRestart(), 10_000);
        }
    }

    /**
     * Perform the actual gRPC setup sequence.
     * Creates the control client, configures the EEBUS service,
     * instantiates and starts use case classes, and subscribes to discovery events.
     */
    async #connect() {
        const config = this.#config;
        const log = this.#adapter.log;

        // Ensure info objects exist with translated names
        await this.#createInfoObjects();

        // Create control client (shared resource)
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

        // Register remote SKI for the control box
        if (config.controlboxSki && config.controlboxSki.length >= 40) {
            await registerRemoteSki(this.#controlClient, config.controlboxSki);
        }

        // Run one-time migration of legacy object paths (idempotent — skips if already migrated)
        await migrate(this.#adapter);

        // Determine which use cases are enabled
        const lpcEnabled = config.lpcEnabled !== false; // default: true
        const lppEnabled = config.lppEnabled === true; // default: false

        // Clean up ioBroker objects for deactivated use cases
        if (!lpcEnabled) {
            await this.#deleteObjectTree('LPC');
        }
        if (!lppEnabled) {
            await this.#deleteObjectTree('LPP');
        }

        // Instantiate use case classes
        if (lpcEnabled) {
            this.#lpcUseCase = new LpcUseCase(this.#adapter, config, this.#controlClient, this.#translate);
        } else {
            this.#lpcUseCase = null;
        }

        if (lppEnabled) {
            this.#lppUseCase = new LppUseCase(this.#adapter, config, this.#controlClient, this.#translate);
        } else {
            this.#lppUseCase = null;
        }

        // Start use case instances — CS registration phase only (registers use cases, creates clients, subscribes events)
        // EG registration happens AFTER startService, matching the original working order:
        // CS use cases must be registered before startService so features are available for external binding.
        // EG use cases must be registered after startService to avoid self-binding conflicts.
        if (this.#lpcUseCase) {
            await this.#lpcUseCase.start();
        }
        if (this.#lppUseCase) {
            await this.#lppUseCase.start();
        }

        // Start the EEBUS service AFTER CS use cases are registered but BEFORE EG use cases
        await startService(this.#controlClient);

        // Now initialize energy guards (registers EG entities + use cases after service is running)
        // Hems creates shared entities for guards that appear in both LPC and LPP (same SKI),
        // so they share one LoadControl binding to the remote device.
        const egEntityMap = await this.#createEgEntities(config);

        if (this.#lpcUseCase) {
            await this.#lpcUseCase.startEnergyGuards(egEntityMap);
        }
        if (this.#lppUseCase) {
            await this.#lppUseCase.startEnergyGuards(egEntityMap);
        }

        // Fetch local SKI from the gRPC server and publish it
        try {
            const certRes = await callUnary(this.#controlClient, 'GetCertificate', {});
            if (certRes.ski) {
                this.#adapter.setState('info.ski', certRes.ski, true);
                log.info(`Local SKI: ${certRes.ski}`);
            }
        } catch (err) {
            log.warn(`Failed to get local SKI: ${err.message}`);
        }

        // Subscribe to discovery events (shared)
        this.#subscribeDiscoveryEvents();

        log.info('HEMS connected and running');
        this.#adapter.setState('info.connection', true, true);
    }

    // ─── Info Objects ───────────────────────────────────────────────────

    /**
     * Create shared ioBroker info objects with translated names.
     * These are retained regardless of which use cases are active:
     * info.connection, info.discoveredDevices, info.ski
     */
    async #createInfoObjects() {
        const t = this.#translate;

        await this.#adapter.extendObjectAsync('info.connection', {
            type: 'state',
            common: {
                name: t('Connection Status'),
                type: 'boolean',
                role: 'indicator.connected',
                def: false,
                read: true,
                write: false,
            },
            native: {},
        });

        await this.#adapter.extendObjectAsync('info.discoveredDevices', {
            type: 'state',
            common: {
                name: t('Discovered Devices'),
                type: 'string',
                role: 'json',
                def: '{}',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.#adapter.extendObjectAsync('info.ski', {
            type: 'state',
            common: {
                name: t('Local SKI'),
                type: 'string',
                role: 'text',
                def: '',
                read: true,
                write: false,
            },
            native: {},
        });
    }

    // ─── Discovery Events ───────────────────────────────────────────────

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
     * Persist the current discovered devices map to the info.discoveredDevices state.
     */
    #persistDiscoveredDevices() {
        const devices = Object.fromEntries(this.#discoveredDevices);
        this.#adapter.setState('info.discoveredDevices', JSON.stringify(devices), true);
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
        this.#retryTimer = this.#adapter.setTimeout(() => {
            this.#retryTimer = null;
            this.restart();
        }, 10_000);
    }

    // ─── Energy Guard Entity Management ─────────────────────────────────

    /**
     * Build the EG entity map for energy guards.
     * Following the enbility HEMS example pattern: all EG use cases are registered
     * on the same CEM entity [1] as the CS use cases. No separate sub-entities needed.
     *
     * @param {object} config - Adapter configuration
     * @returns {Promise<Map<string, number[]>>} Map of SKI → entity address (always [1])
     */
    async #createEgEntities(config) {
        const egEntityMap = new Map(); // SKI → entityAddr

        // Collect all unique EEBUS SKIs from both LPC and LPP guard configs
        const lpcGuards = config.energyGuards || [];
        const lppGuards = config.lppEnergyGuards || [];

        for (const g of lpcGuards) {
            if (g.type === 'eebus' && g.ski) {
                egEntityMap.set(g.ski, [1]);
            }
        }
        for (const g of lppGuards) {
            if (g.type === 'eebus' && g.ski) {
                egEntityMap.set(g.ski, [1]);
            }
        }

        return egEntityMap;
    }

    // ─── Object Cleanup ─────────────────────────────────────────────────

    /**
     * Delete all ioBroker objects under a given prefix (folder + all children).
     * Used to clean up objects when a use case is deactivated.
     *
     * @param {string} prefix - The top-level folder to delete (e.g., "LPC" or "LPP")
     */
    async #deleteObjectTree(prefix) {
        const log = this.#adapter.log;
        const adapterNamespace = this.#adapter.namespace;

        let objects;
        try {
            objects = await this.#adapter.getAdapterObjectsAsync();
        } catch (err) {
            log.warn(`Failed to get adapter objects for cleanup of "${prefix}": ${err.message}`);
            return;
        }

        // Find all objects that belong to this prefix
        const toDelete = Object.keys(objects).filter(id => {
            const localId = id.replace(`${adapterNamespace}.`, '');
            return localId === prefix || localId.startsWith(`${prefix}.`);
        });

        if (toDelete.length === 0) {
            return; // nothing to clean up
        }

        log.info(`Cleaning up ${toDelete.length} object(s) for deactivated use case "${prefix}"`);

        // Sort by depth descending so children are deleted before parents
        toDelete.sort((a, b) => b.split('.').length - a.split('.').length);

        for (const fullId of toDelete) {
            const localId = fullId.replace(`${adapterNamespace}.`, '');
            try {
                await this.#adapter.delObjectAsync(localId);
            } catch (err) {
                log.warn(`Failed to delete object "${localId}": ${err.message}`);
            }
        }
    }
}

module.exports = { Hems };
