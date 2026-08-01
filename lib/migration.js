'use strict';

/**
 * Migration module for one-time object tree reorganization.
 *
 * Moves LPC states from legacy paths:
 *   info.state, info.limit, info.limitDuration, info.limitMinutesToday → LPC.*
 *   EnergyGuards.Guard_* → LPC.EnergyGuards.Guard_*
 *
 * Retains: info.connection, info.discoveredDevices, info.ski (untouched)
 *
 * Each step is independent — if one migration fails, the error is logged and the
 * remaining items continue. This is a pure utility module with no dependencies on
 * Hems, LPC, or LPP classes.
 */

/**
 * LPC states that need to be migrated from the "info" folder to the "LPC" folder.
 */
const LPC_STATE_KEYS = ['state', 'limit', 'limitDuration', 'limitMinutesToday'];

/**
 * Energy guard state keys to copy during guard migration.
 */
const GUARD_STATE_KEYS = ['percentage', 'failsafeLimit'];

/**
 * Run one-time migration of LPC objects from legacy paths to new LPC folder structure.
 *
 * @param {object} adapter - ioBroker adapter instance
 */
async function migrate(adapter) {
    const log = adapter.log;

    log.debug('Migration: checking for legacy LPC objects to migrate');

    await migrateLpcStates(adapter);
    await migrateLpcEnergyGuards(adapter);

    log.debug('Migration: completed');
}

/**
 * Migrate LPC states from info.* to LPC.*.
 * Skips gracefully if no states exist at old paths.
 *
 * @param {object} adapter - ioBroker adapter instance
 */
async function migrateLpcStates(adapter) {
    const log = adapter.log;

    // Check if any legacy LPC states exist
    let hasLegacyStates = false;
    for (const key of LPC_STATE_KEYS) {
        const oldObj = await adapter.getObjectAsync(`info.${key}`);
        if (oldObj) {
            hasLegacyStates = true;
            break;
        }
    }

    if (!hasLegacyStates) {
        log.debug('Migration: no legacy LPC states found under "info" — skipping state migration');
        return;
    }

    log.info('Migration: migrating LPC states from info.* to LPC.*');

    // Create the LPC folder
    try {
        await adapter.extendObjectAsync('LPC', {
            type: 'folder',
            common: { name: 'LPC' },
            native: {},
        });
    } catch (err) {
        log.error(`Migration: failed to create LPC folder — ${err.message}`);
        // Continue anyway; individual state migrations may still work if folder exists
    }

    // Migrate each state independently
    for (const key of LPC_STATE_KEYS) {
        try {
            const oldPath = `info.${key}`;
            const newPath = `LPC.${key}`;

            const oldObj = await adapter.getObjectAsync(oldPath);
            if (!oldObj) {
                log.debug(`Migration: ${oldPath} does not exist — skipping`);
                continue;
            }

            // Read current value
            const oldState = await adapter.getStateAsync(oldPath);
            const value = oldState ? oldState.val : null;

            // Create new object at LPC.* (preserve common definition from old object)
            await adapter.extendObjectAsync(newPath, {
                type: oldObj.type,
                common: oldObj.common,
                native: oldObj.native || {},
            });

            // Copy value if it exists
            if (value !== null && value !== undefined) {
                await adapter.setStateAsync(newPath, value, true);
            }

            // Delete old object
            await adapter.delObjectAsync(oldPath);

            log.info(`Migration: migrated ${oldPath} → ${newPath}`);
        } catch (err) {
            log.error(`Migration: failed to migrate info.${key} — ${err.message}`);
            // Continue with remaining states
        }
    }
}

/**
 * Migrate LPC energy guards from EnergyGuards.Guard_* to LPC.EnergyGuards.Guard_*.
 * Copies percentage and failsafeLimit values for each guard.
 * After all guards are migrated, deletes the old top-level EnergyGuards folder.
 * Skips gracefully if no old guards exist.
 *
 * @param {object} adapter - ioBroker adapter instance
 */
async function migrateLpcEnergyGuards(adapter) {
    const log = adapter.log;
    const adapterNamespace = adapter.namespace;

    // Get all objects to find old EnergyGuards channels
    let objects;
    try {
        objects = await adapter.getAdapterObjectsAsync();
    } catch (err) {
        log.error(`Migration: failed to get adapter objects — ${err.message}`);
        return;
    }

    // Find old guard channels at the top-level EnergyGuards path
    // They look like: eebus-go.0.EnergyGuards.Guard_Name (type: channel)
    const oldGuardChannels = Object.keys(objects).filter(id => {
        const localId = id.replace(`${adapterNamespace}.`, '');
        return (
            localId.startsWith('EnergyGuards.Guard_') &&
            !localId.startsWith('LPC.EnergyGuards.') &&
            !localId.startsWith('LPP.EnergyGuards.') &&
            objects[id].type === 'channel'
        );
    });

    if (oldGuardChannels.length === 0) {
        log.debug('Migration: no legacy EnergyGuards found — skipping guard migration');
        return;
    }

    log.info(
        `Migration: migrating ${oldGuardChannels.length} energy guard(s) from EnergyGuards.* to LPC.EnergyGuards.*`,
    );

    // Create the LPC and LPC.EnergyGuards folders
    try {
        await adapter.extendObjectAsync('LPC', {
            type: 'folder',
            common: { name: 'LPC' },
            native: {},
        });
        await adapter.extendObjectAsync('LPC.EnergyGuards', {
            type: 'folder',
            common: { name: 'EnergyGuards' },
            native: {},
        });
    } catch (err) {
        log.error(`Migration: failed to create LPC.EnergyGuards folder — ${err.message}`);
        // Continue anyway
    }

    // Migrate each guard
    for (const fullChannelId of oldGuardChannels) {
        const localId = fullChannelId.replace(`${adapterNamespace}.`, '');
        // localId is like "EnergyGuards.Guard_WallBox"
        const guardName = localId.replace('EnergyGuards.', '');
        // guardName is like "Guard_WallBox"
        const newChannelPath = `LPC.EnergyGuards.${guardName}`;

        try {
            // Create new channel
            await adapter.extendObjectAsync(newChannelPath, {
                type: 'channel',
                common: objects[fullChannelId].common || { name: guardName },
                native: objects[fullChannelId].native || {},
            });

            // Copy guard state values (percentage, failsafeLimit)
            for (const stateKey of GUARD_STATE_KEYS) {
                const oldStatePath = `${localId}.${stateKey}`;
                const newStatePath = `${newChannelPath}.${stateKey}`;
                const fullOldStateId = `${adapterNamespace}.${oldStatePath}`;

                // Check if old state object exists
                if (!objects[fullOldStateId]) {
                    log.debug(`Migration: ${oldStatePath} does not exist — skipping`);
                    continue;
                }

                // Create new state object
                await adapter.extendObjectAsync(newStatePath, {
                    type: objects[fullOldStateId].type || 'state',
                    common: objects[fullOldStateId].common || {},
                    native: objects[fullOldStateId].native || {},
                });

                // Copy value
                const oldState = await adapter.getStateAsync(oldStatePath);
                if (oldState && oldState.val !== null && oldState.val !== undefined) {
                    await adapter.setStateAsync(newStatePath, oldState.val, true);
                }
            }

            log.info(`Migration: migrated ${localId} → ${newChannelPath}`);
        } catch (err) {
            log.error(`Migration: failed to migrate energy guard "${guardName}" — ${err.message}`);
            // Continue with remaining guards
        }
    }

    // Delete old guard objects (children first, then channels, then folder)
    try {
        // Delete all objects under old EnergyGuards (including children of channels)
        const oldEnergyGuardObjects = Object.keys(objects).filter(id => {
            const localId = id.replace(`${adapterNamespace}.`, '');
            return (
                localId.startsWith('EnergyGuards.') &&
                !localId.startsWith('LPC.EnergyGuards.') &&
                !localId.startsWith('LPP.EnergyGuards.')
            );
        });

        // Sort by depth descending so children are deleted before parents
        oldEnergyGuardObjects.sort((a, b) => b.split('.').length - a.split('.').length);

        for (const fullId of oldEnergyGuardObjects) {
            const localId = fullId.replace(`${adapterNamespace}.`, '');
            try {
                await adapter.delObjectAsync(localId);
            } catch (err) {
                log.warn(`Migration: failed to delete old object "${localId}" — ${err.message}`);
            }
        }

        // Delete the top-level EnergyGuards folder itself
        try {
            await adapter.delObjectAsync('EnergyGuards');
        } catch (err) {
            // May not exist as a separate folder object — that's fine
            log.debug(`Migration: could not delete EnergyGuards folder — ${err.message}`);
        }

        log.info('Migration: deleted old EnergyGuards folder and contents');
    } catch (err) {
        log.error(`Migration: failed to clean up old EnergyGuards objects — ${err.message}`);
    }
}

module.exports = { migrate };
