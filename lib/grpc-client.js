const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

/**
 * Load a protobuf definition and return the gRPC package object.
 *
 * @param {string} protoDir - Root directory for proto includes
 * @param {string} relPath - Relative path to the .proto file
 * @returns {object} gRPC package definition
 */
function loadProto(protoDir, relPath) {
    const abs = path.join(protoDir, relPath);
    const def = protoLoader.loadSync(abs, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [protoDir],
    });
    return grpc.loadPackageDefinition(def);
}

/**
 * Resolve a nested property by dot-separated path.
 *
 * @param {object} root - The root object to traverse
 * @param {string} dotted - Dot-separated property path
 * @returns {object | undefined} The resolved value or undefined
 */
function getByPath(root, dotted) {
    let current = root;
    for (const k of dotted.split('.')) {
        if (!current) {
            return undefined;
        }
        // @ts-expect-error — dynamic property access on proto package object
        current = current[k];
    }
    return current;
}

/**
 * Create a gRPC client for the given service.
 *
 * @param {object} options - Client options
 * @param {string} options.protoDir - Root directory for proto includes
 * @param {string} options.protoRelPath - Relative path to the .proto file
 * @param {string} options.pkg - Dot-separated package name
 * @param {string} options.service - Service name within the package
 * @param {string} options.endpoint - host:port to connect to
 * @returns {object} gRPC service client instance
 */
function makeClient({ protoDir, protoRelPath, pkg, service, endpoint }) {
    const root = loadProto(protoDir, protoRelPath);
    const pkgObj = getByPath(root, pkg);
    if (!pkgObj) {
        throw new Error(`Package not found: ${pkg} (proto=${protoRelPath})`);
    }
    // @ts-expect-error — dynamic access to service constructor on proto package
    const ctor = pkgObj[service];
    if (!ctor) {
        throw new Error(`Service not found: ${pkg}.${service} (proto=${protoRelPath})`);
    }
    return new ctor(endpoint, grpc.credentials.createInsecure());
}

/**
 * Default deadline for unary RPC calls (30 seconds).
 */
const DEFAULT_DEADLINE_MS = 30000;

/**
 * Invoke a unary RPC method and return a promise.
 * Applies a 30-second deadline by default to prevent indefinite hangs.
 *
 * @param {object} client - gRPC client instance
 * @param {string} method - RPC method name
 * @param {object} [req] - Request message
 * @param {object} [options] - Call options
 * @param {number} [options.deadlineMs] - Deadline in milliseconds (default: 30000)
 * @returns {Promise<object>} Response message
 */
function callUnary(client, method, req = {}, options = {}) {
    return new Promise((resolve, reject) => {
        // @ts-expect-error — dynamic method lookup on gRPC client
        const fn = client[method];
        if (typeof fn !== 'function') {
            return reject(new Error(`RPC not found: ${method}`));
        }
        const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
        const callOptions = { deadline: new Date(Date.now() + deadlineMs) };
        fn.call(
            client,
            req,
            callOptions,
            // @ts-expect-error — gRPC callback params are untyped
            (err, resp) => (err ? reject(err) : resolve(resp)),
        );
    });
}

/**
 * Determine whether a gRPC error indicates a transport/connection failure
 * (as opposed to an application-level error from the remote service).
 *
 * Transport errors warrant a full reconnect; application errors do not.
 *
 * @param {{code?: number}} err - Error object from a gRPC call
 * @returns {boolean} true if the error is a transport/connection failure
 */
function isTransportError(err) {
    const code = err && err.code;
    return code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED || code === grpc.status.CANCELLED;
}

/**
 * Extract the target endpoint from a gRPC client (strips the dns: scheme prefix).
 *
 * @param {object} client - gRPC client instance
 * @returns {string} host:port endpoint
 */
function getEndpoint(client) {
    const target = client.getChannel().getTarget();
    return target.replace(/^dns:/, '');
}

module.exports = { makeClient, callUnary, isTransportError, getEndpoint };
