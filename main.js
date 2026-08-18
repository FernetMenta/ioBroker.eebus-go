'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const path = require('node:path');
const fs = require('node:fs');
const { I18n } = require('@iobroker/adapter-core');
const { DockerManager } = require('@iobroker/plugin-docker');
const { Hems } = require('./lib/hems');

class EebusGo extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'eebus-go',
        });
        this.hems = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Returns the Docker volume name for the eebus-certs volume.
     * The plugin prefixes it with iob_<adapterName>_<instance>_
     */
    get certsVolumeName() {
        return `iob_eebus_go_${this.instance}_eebus-certs`;
    }

    /**
     * Returns the local path where certs are backed up within the adapter data directory.
     */
    get certsBackupDir() {
        return 'certs';
    }

    /**
     * Create a standalone DockerManager instance using the same API config as the plugin.
     * This is needed because the plugin's own manager isn't available before instanceIsReady().
     *
     * @param {{ silent?: boolean }} [options] - Options for creating the manager
     */
    async createDockerManager(options) {
        const silent = options && options.silent;
        // Read the dockerApi config the same way the plugin does
        const pluginConfig = this.getPluginConfig('docker');
        let dockerApi;
        if (pluginConfig && pluginConfig.iobDockerApi && typeof pluginConfig.iobDockerApi === 'string') {
            const systemDockerObj = await this.getForeignObjectAsync('system.docker');
            const nativeConfig = systemDockerObj?.native;
            if (nativeConfig?.hosts?.[pluginConfig.iobDockerApi]) {
                dockerApi = nativeConfig.hosts[pluginConfig.iobDockerApi];
            }
        } else if (pluginConfig && typeof pluginConfig.iobDockerApi === 'object') {
            dockerApi = pluginConfig.iobDockerApi;
        }

        const logger = silent
            ? { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
            : this.log;

        const manager = new DockerManager({
            dockerApi,
            logger,
            namespace: `${this.name}.${this.instance}`,
        });
        await manager.isReady();
        return manager;
    }

    /**
     * Copy certificate files from the Docker volume to the ioBroker file storage.
     * Called when info.connection becomes true (container is running with valid certs).
     * Files are visible in admin Files tab and included in ioBroker backups.
     */
    async backupCertsFromVolume() {
        try {
            const manager = await this.createDockerManager();

            const entries = await manager.volumeDir(this.certsVolumeName);
            if (typeof entries === 'string' || !entries.length) {
                this.log.debug('No cert files found in Docker volume to back up');
                return;
            }

            for (const entry of entries) {
                if (entry.isDir || entry.isLink) {
                    continue;
                }
                const content = await manager.volumeFile(this.certsVolumeName, entry.name);
                if (content != null) {
                    await this.writeFileAsync(this.namespace, `${this.certsBackupDir}/${entry.name}`, content);
                }
            }
            this.log.info('Backed up cert files from Docker volume to ioBroker file storage');
        } catch (e) {
            this.log.warn(`Could not back up certs from Docker volume: ${e.message}`);
        }
    }

    /**
     * Copy certificate files from ioBroker file storage into the Docker volume.
     * Called before signaling instanceIsReady so the container starts with restored certs.
     */
    async restoreCertsToVolume() {
        let files;
        try {
            const result = await this.readDirAsync(this.namespace, this.certsBackupDir);
            files = result.filter(entry => entry.isDir === false);
        } catch {
            // Directory doesn't exist — first run
            this.log.debug('No cert backup in file storage — skipping restore to volume');
            return;
        }

        if (!files.length) {
            this.log.debug('Cert backup in file storage is empty — skipping restore to volume');
            return;
        }

        // Write cert files to a temporary directory, then copy to volume
        const tmpDir = path.join(require('node:os').tmpdir(), `eebus-certs-restore-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            for (const file of files) {
                const { file: data } = await this.readFileAsync(this.namespace, `${this.certsBackupDir}/${file.file}`);
                fs.writeFileSync(path.join(tmpDir, file.file), data);
            }

            const manager = await this.createDockerManager();
            const result = await manager.volumeCopyTo(this.certsVolumeName, tmpDir);
            if (result.stderr) {
                this.log.warn(`Could not restore certs to Docker volume: ${result.stderr}`);
            } else {
                this.log.info(`Restored ${files.length} cert files to Docker volume from file storage`);
            }
        } catch (e) {
            this.log.warn(`Could not restore certs to Docker volume: ${e.message}`);
        } finally {
            // Clean up temp directory
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Check Docker availability and publish result as a state for the admin UI
        let dockerAvailable = false;
        try {
            const manager = await this.createDockerManager({ silent: true });
            const info = await manager.getDockerDaemonInfo();
            dockerAvailable = !!info.daemonRunning;
        } catch {
            // Docker not installed or not reachable
        }
        await this.setStateAsync('info.dockerInstalled', dockerAvailable, true);

        // When Docker container is managed by the plugin, always connect to the local container endpoint
        if (this.config.dockerEnabled) {
            if (!dockerAvailable) {
                this.log.error(
                    'Docker is configured but the Docker daemon is not running. ' +
                        'Please start Docker or disable the Docker container in the adapter settings.',
                );
                return;
            }

            this.config.grpcEndpoint = '127.0.0.1:50051';

            // Restore certs to the Docker volume before the container starts.
            // The compose file has iobWaitForReady=true, so the container won't start
            // until we call instanceIsReady() below.
            await this.restoreCertsToVolume();

            // Signal the Docker plugin that provisioning is complete — the container can start now.
            const dockerPlugin = this.getPluginInstance('docker');
            if (dockerPlugin) {
                await dockerPlugin.instanceIsReady();
            }
        }

        if (!this.config.grpcEndpoint) {
            this.log.error('grpcEndpoint is not configured — please set it in the adapter settings');
            return;
        }

        // Initialize I18n for translated object names
        await I18n.init(path.join(__dirname, 'lib'), this);

        // Subscribe to info.connection to trigger cert backup when connected
        this.subscribeStates('info.connection');

        // Subscribe to Energy Guard state changes (percentage, heartbeat, connected, manualLimit)
        this.subscribeStates('LPC.EnergyGuards.*');
        this.subscribeStates('LPP.EnergyGuards.*');

        this.hems = new Hems(this, I18n.translate);
        this.hems.restart();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            if (this.hems) {
                this.hems.stop();
                this.hems = null;
            }

            this.setState('info.connection', false, true);
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // onObjectChange(id, obj) {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - State ID
     * @param {ioBroker.State | null | undefined} state - State object
     */
    onStateChange(id, state) {
        if (state) {
            // When info.connection becomes true, back up certs from the Docker volume
            if (id.endsWith('.info.connection') && state.val === true && state.ack === true) {
                if (this.config.dockerEnabled) {
                    this.backupCertsFromVolume();
                }
                return;
            }

            if (state.ack === false) {
                if ((id.includes('.EnergyGuards.') || id.includes('.LPC.') || id.includes('.LPP.')) && this.hems) {
                    this.log.info(`User command for ${id}: ${state.val}`);
                    this.hems.handleEnergyGuardStateChange(id, state);
                } else {
                    this.log.debug(`Ignoring state change (no handler): ${id} = ${state.val}`);
                }
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new EebusGo(options);
} else {
    // otherwise start the instance directly
    new EebusGo();
}
