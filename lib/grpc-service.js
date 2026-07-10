const { callUnary } = require('./grpc');

/**
 * Split a comma-separated string into a trimmed, non-empty array.
 *
 * @param {string} s - Comma-separated input
 * @returns {string[]} Array of trimmed non-empty tokens
 */
const csv = s =>
    String(s || '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);

/**
 * Build an EntityAddress message from numeric address parts.
 *
 * @param {...number} parts - Address parts as numeric values
 * @returns {{entity_address: number[]}} EntityAddress message
 */
function entityAddress(...parts) {
    return { entity_address: parts.map(n => Number(n)) };
}

/**
 * Send device configuration to the EEBUS service.
 *
 * @param {object} controlClient - gRPC control client
 * @param {object} env - Environment variables for configuration
 * @returns {Promise<void>}
 */
async function setConfig(controlClient, env) {
    const req = {
        port: Number(env.SERVICE_PORT || 4715),
        vendor_code: env.VENDOR_CODE || '',
        device_brand: env.DEVICE_BRAND || '',
        device_model: env.DEVICE_MODEL || '',
        serial_number: env.SERIAL_NUMBER || '',
        device_categories: csv(env.DEVICE_CATEGORIES), // DeviceCategory.Enum (Strings)
        device_type: env.DEVICE_TYPE || 'UNKNOWN', // DeviceType.Enum (String)
        entity_types: csv(env.ENTITY_TYPES), // EntityType.Enum (Strings)
        heartbeat_timeout_seconds: Number(env.HEARTBEAT_TIMEOUT_SECONDS || 30),
    };
    await callUnary(controlClient, 'SetConfig', req);
}

/**
 * Start the EEBUS service.
 *
 * @param {object} controlClient - gRPC control client
 * @returns {Promise<void>}
 */
async function startService(controlClient) {
    await callUnary(controlClient, 'StartService', {});
}

/**
 * Reset the EEBUS service.
 *
 * @param {object} controlClient - gRPC control client
 * @returns {Promise<void>}
 */
async function resetService(controlClient) {
    await callUnary(controlClient, 'ResetService', {});
}

/**
 * Start the EEBUS setup process.
 *
 * @param {object} controlClient - gRPC control client
 * @returns {Promise<void>}
 */
async function startSetup(controlClient) {
    await callUnary(controlClient, 'StartSetup', {});
}

/**
 * Add an entity to the EEBUS service
 *
 * @param {object} controlClient - gRPC control client
 * @param {string} typeEnumString - EntityType enum value
 * @param {number[]} addrParts - Entity address parts
 * @returns {Promise<void>}
 */
async function addEntity(controlClient, typeEnumString, addrParts) {
    await callUnary(controlClient, 'AddEntity', {
        type: typeEnumString, // EntityType.Enum
        address: entityAddress(...addrParts), // common_types.EntityAddress
    });
}

/**
 * Add the CS LPC (Limitation of Power Consumption) use case.
 *
 * @param {object} controlClient - gRPC control client
 * @param {number[]} csAddr - Controllable system entity address
 * @returns {Promise<object>} The endpoint from the response
 */
async function addCsLpcUseCase(controlClient, csAddr) {
    const res = await callUnary(controlClient, 'AddUseCase', {
        entity_address: { entity_address: csAddr }, // NIE leer!
        use_case: { actor: 'ControllableSystem', name: 'limitationOfPowerConsumption' },
    });
    return res.endpoint;
}

/**
 * Subscribe to CS LPC use case events via server streaming.
 *
 * @param {object} controlClient - gRPC control client
 * @param {number[]} csEntityAddrParts - CS entity address parts
 * @param {(event: object) => void} onEvent - Callback invoked for each event
 * @returns {object} gRPC readable stream
 */
function subscribeCsLpcEvents(controlClient, csEntityAddrParts, onEvent) {
    const stream = controlClient.SubscribeUseCaseEvents({
        entity_address: entityAddress(...csEntityAddrParts),
        use_case: {
            actor: 'ControllableSystem',
            name: 'limitationOfPowerConsumption',
        },
    });

    stream.on('data', onEvent);
    stream.on('error', err => console.error('[control] event stream error:', err.message));
    stream.on('end', () => console.warn('[control] event stream ended'));
    return stream;
}

/**
 * Register a remote ControlBox SKI as trusted.
 *
 * @param {object} controlClient - gRPC control client
 * @param {string} ski - Subject Key Identifier (min 40 chars)
 * @returns {Promise<void>}
 */
async function registerRemoteSki(controlClient, ski) {
    if (!ski || ski.length < 40) {
        throw new Error('CONTROLBOX_SKI fehlt oder ungültig');
    }

    await callUnary(controlClient, 'RegisterRemoteSki', {
        remote_ski: ski,
    });

    console.log('[trust] ControlBox SKI registriert:', ski);
}

module.exports = {
    setConfig,
    startService,
    resetService,
    startSetup,
    addEntity,
    addCsLpcUseCase,
    subscribeCsLpcEvents,
    registerRemoteSki,
};
