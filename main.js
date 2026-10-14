'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
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
        this.on('message', this.onMessage.bind(this));
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
     * Parse a Docker API URL into the connection struct expected by the `@iobroker/plugin-docker`
     * DockerManager. Returns undefined for an empty/blank input, which tells the plugin to
     * auto-detect the local endpoint (socket -> :2375 -> :2376 -> CLI).
     *
     * Supported today: http:// and https:// (TCP). The resulting struct is
     *   { host, port, protocol, ca, cert, key }
     *
     * TODO(unix-socket): A feature request is open at the plugin-docker repo to accept unix
     * socket URLs for iobDockerApi, e.g. "unix:///run/user/1000/podman/podman.sock" (rootless
     * Podman). The current plugin (1.1.2) ignores anything without host+port and has no
     * socketPath field, so we deliberately do NOT emit a socketPath yet — it would silently fall
     * back to auto-detection. Once the plugin supports it (likely a `socketPath` field on the
     * dockerApi struct), extend this parser to map the "unix:" scheme to { socketPath: <path> }
     * and bump the plugin-docker dependency.
     *
     * @param {string} url - e.g. "http://127.0.0.1:2375" or "" for auto-detect
     * @returns {{ host: string, port: number, protocol: 'http' | 'https', ca: string, cert: string, key: string } | undefined} parsed connection struct, or undefined to auto-detect
     */
    static parseDockerApiUrl(url) {
        if (!url || typeof url !== 'string' || !url.trim()) {
            return undefined;
        }
        const trimmed = url.trim();
        let parsed;
        try {
            parsed = new URL(trimmed);
        } catch {
            throw new Error(`Invalid Docker API URL: "${trimmed}"`);
        }

        const scheme = parsed.protocol.replace(/:$/, '');

        // TODO(unix-socket): handle scheme === 'unix' here once plugin-docker supports socketPath.
        if (scheme !== 'http' && scheme !== 'https') {
            throw new Error(`Unsupported Docker API scheme "${scheme}" (only http/https are supported)`);
        }

        const host = parsed.hostname;
        if (!host) {
            throw new Error(`Docker API URL is missing a host: "${trimmed}"`);
        }
        // Default ports mirror Docker/Podman conventions: 2375 (http), 2376 (https/tls).
        const port = parsed.port ? parseInt(parsed.port, 10) : scheme === 'https' ? 2376 : 2375;

        return {
            host,
            port,
            protocol: scheme,
            ca: '',
            cert: '',
            key: '',
        };
    }

    /**
     * Resolve the Docker API connection config from the adapter's native config.
     * Returns undefined when no API is configured (plugin auto-detects the local endpoint).
     *
     * @returns {{ host: string, port: number, protocol: 'http' | 'https', ca: string, cert: string, key: string } | undefined} configured connection struct, or undefined to auto-detect
     */
    getDockerApi() {
        // Prefer the already-parsed struct (what the plugin consumes via ${config.dockerApi}).
        if (this.config.dockerApi && typeof this.config.dockerApi === 'object' && this.config.dockerApi.host) {
            return this.config.dockerApi;
        }
        // Fall back to parsing the human-readable URL, if present.
        if (this.config.dockerApiUrl) {
            try {
                return EebusGo.parseDockerApiUrl(this.config.dockerApiUrl);
            } catch (e) {
                this.log.warn(`Ignoring invalid Docker API URL: ${e.message}`);
            }
        }
        return undefined;
    }

    /**
     * Fast reachability probe for a Docker/Podman HTTP API, mirroring `curl http://host:port/info`.
     * Does a direct GET /info with a short timeout — it does NOT go through DockerManager, which
     * also runs the local `docker` CLI (slow / hangs when only Podman over TCP is present).
     *
     * For an empty struct (auto-detect) it tries the local unix socket, then :2375, then :2376.
     *
     * @param {{ host: string, port: number, protocol: 'http' | 'https', ca?: string, cert?: string, key?: string } | undefined} dockerApi - parsed connection struct, or undefined to auto-detect
     * @param {number} [timeoutMs] - per-request timeout, default 3000 ms
     * @returns {Promise<{ success: boolean, serverVersion?: string, osType?: string, error?: string }>} probe result
     */
    static async probeDockerApi(dockerApi, timeoutMs = 3000) {
        /**
         * @param {object} requestOptions - options for http/https request
         * @param {boolean} secure - whether to use https
         */
        const requestInfo = (requestOptions, secure) =>
            new Promise((resolve, reject) => {
                const lib = secure ? https : http;
                const req = lib.request({ ...requestOptions, path: '/info', method: 'GET' }, res => {
                    let data = '';
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                const parsed = JSON.parse(data);
                                resolve({ serverVersion: parsed.ServerVersion, osType: parsed.OSType });
                            } catch {
                                // Reachable but not JSON — still counts as reachable.
                                resolve({});
                            }
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}`));
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs} ms`)));
                req.end();
            });

        // Explicit TCP endpoint configured.
        if (dockerApi && dockerApi.host && dockerApi.port) {
            const secure = dockerApi.protocol === 'https';
            const options = { host: dockerApi.host, port: dockerApi.port, timeout: timeoutMs };
            if (secure) {
                if (dockerApi.ca) {
                    options.ca = dockerApi.ca;
                }
                if (dockerApi.cert) {
                    options.cert = dockerApi.cert;
                }
                if (dockerApi.key) {
                    options.key = dockerApi.key;
                }
                options.rejectUnauthorized = !!dockerApi.ca;
            }
            try {
                const info = await requestInfo(options, secure);
                return { success: true, serverVersion: info.serverVersion, osType: info.osType };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }

        // Auto-detect: local unix socket first, then default TCP ports.
        const socketPath = '/var/run/docker.sock';
        const socketReachable = await new Promise(resolve => {
            const sock = net.createConnection({ path: socketPath });
            const done = ok => {
                sock.destroy();
                resolve(ok);
            };
            sock.on('connect', () => done(true));
            sock.on('error', () => done(false));
            sock.setTimeout(timeoutMs, () => done(false));
        });
        if (socketReachable) {
            try {
                const info = await requestInfo({ socketPath, timeout: timeoutMs }, false);
                return { success: true, serverVersion: info.serverVersion, osType: info.osType };
            } catch {
                // fall through to TCP probes
            }
        }
        for (const port of [2375, 2376]) {
            try {
                const info = await requestInfo({ host: '127.0.0.1', port, timeout: timeoutMs }, port === 2376);
                return { success: true, serverVersion: info.serverVersion, osType: info.osType };
            } catch {
                // try next
            }
        }
        return { success: false, error: 'No Docker/Podman API reachable (socket, :2375, :2376)' };
    }

    /**
     * Create a standalone DockerManager instance using the same API config as the plugin.
     * This is needed because the plugin's own manager isn't available before `instanceIsReady()`.
     *
     * @param {{ silent?: boolean, dockerApi?: object }} [options] - Options for creating the manager
     */
    async createDockerManager(options) {
        const silent = options && options.silent;
        // Use an explicitly supplied API (e.g. for a config test), otherwise the configured one.
        const dockerApi = options && options.dockerApi !== undefined ? options.dockerApi : this.getDockerApi();

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
     * Ensure the `alpine` helper image is present before any volume operation.
     *
     * The plugin's volumeDir()/volumeFile() run a short-lived `alpine` container to read a volume
     * but — unlike volumeCopyTo() — do NOT pull the image first. On a host where `alpine` is not
     * cached (notably rootless Podman, which does not implicitly pull for `dockerode.run`), this
     * fails with "no such image: docker.io/library/alpine: image not known". Pulling it once up
     * front makes backup and restore work out of the box on both Docker and Podman.
     *
     * @param {InstanceType<typeof DockerManager>} manager - the manager to pull with
     * @returns {Promise<boolean>} true if the image is available afterwards
     */
    async ensureHelperImage(manager) {
        try {
            const images = await manager.imageList();
            if (images && images.find(img => img.repository === 'alpine')) {
                return true;
            }
            const result = await manager.imagePull('alpine');
            if (result && result.stderr) {
                this.log.warn(`Could not pull "alpine" helper image: ${result.stderr}`);
                return false;
            }
            return true;
        } catch (e) {
            this.log.warn(`Could not ensure "alpine" helper image: ${e.message}`);
            return false;
        }
    }

    /**
     * Copy certificate files from the Docker volume to the ioBroker file storage.
     * Called when info.connection becomes true (container is running with valid certs).
     * Files are visible in admin Files tab and included in ioBroker backups.
     */
    async backupCertsFromVolume() {
        try {
            const manager = await this.createDockerManager();
            await this.ensureHelperImage(manager);

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
            await this.ensureHelperImage(manager);
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

    /**
     * Handle messages from the admin UI.
     * Supports "testDockerApi": probe a Docker/Podman API endpoint and report whether it answers.
     * The admin browser usually cannot reach the Docker endpoint directly, so the running adapter
     * does the probe on its behalf. This requires the instance to be running.
     *
     * @param {ioBroker.Message} obj - Incoming message
     */
    async onMessage(obj) {
        if (!obj || typeof obj !== 'object' || !obj.command) {
            return;
        }

        if (obj.command === 'testDockerApi') {
            const url = obj.message && typeof obj.message === 'object' ? obj.message.url : obj.message;
            let result;
            try {
                // An empty URL means "auto-detect the local endpoint".
                const dockerApi = EebusGo.parseDockerApiUrl(typeof url === 'string' ? url : '');
                // Direct, fast GET /info (like `curl`), NOT via DockerManager — the latter also
                // shells out to the `docker` CLI, which hangs for ~10s on a Podman-over-TCP host.
                result = await EebusGo.probeDockerApi(dockerApi);
            } catch (e) {
                result = { success: false, error: e.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        this.log.debug(`Ignoring unknown message command: ${obj.command}`);
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
                    this.log.debug(`User command for ${id}: ${state.val}`);
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
