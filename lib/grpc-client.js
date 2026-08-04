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
 * @returns {object} The resolved value or undefined
 */
function getByPath(root, dotted) {
    return dotted.split('.').reduce((acc, k) => (acc ? acc[k] : undefined), root);
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
    const ctor = pkgObj[service];
    if (!ctor) {
        throw new Error(`Service not found: ${pkg}.${service} (proto=${protoRelPath})`);
    }
    return new ctor(endpoint, grpc.credentials.createInsecure());
}

/**
 * Invoke a unary RPC method and return a promise.
 *
 * @param {object} client - gRPC client instance
 * @param {string} method - RPC method name
 * @param {object} [req] - Request message
 * @returns {Promise<object>} Response message
 */
function callUnary(client, method, req = {}) {
    return new Promise((resolve, reject) => {
        const fn = client[method];
        if (typeof fn !== 'function') {
            return reject(new Error(`RPC not found: ${method}`));
        }
        fn.call(client, req, (err, resp) => (err ? reject(err) : resolve(resp)));
    });
}

/**
 * Determine whether a gRPC error indicates a transport/connection failure
 * (as opposed to an application-level error from the remote service).
 *
 * Transport errors warrant a full reconnect; application errors do not.
 *
 * @param {object} err - Error object from a gRPC call
 * @returns {boolean} true if the error is a transport/connection failure
 */
function isTransportError(err) {
    const code = err && err.code;
    return code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED || code === grpc.status.CANCELLED;
}

module.exports = { makeClient, callUnary, isTransportError };
