'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { migrate } = require('./migration');

const { expect } = chai;

/**
 * Create a mock ioBroker adapter with configurable object/state stores.
 *
 * @param {object} [options] - Configuration options
 * @param {object} [options.objects] - Pre-existing objects keyed by full ID
 * @param {object} [options.states] - Pre-existing states keyed by local path
 * @returns {object} Mock adapter
 */
function createMockAdapter(options = {}) {
    const { objects = {}, states = {} } = options;
    const createdObjects = {};
    const createdStates = {};
    const deletedObjects = [];

    const adapter = {
        namespace: 'eebus-go.0',
        log: {
            debug: sinon.stub(),
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
        },
        getObjectAsync: sinon.stub().callsFake(async localPath => {
            const fullId = `eebus-go.0.${localPath}`;
            return objects[fullId] || null;
        }),
        getStateAsync: sinon.stub().callsFake(async localPath => {
            return states[localPath] || null;
        }),
        extendObjectAsync: sinon.stub().callsFake(async (localPath, obj) => {
            createdObjects[localPath] = obj;
        }),
        setStateAsync: sinon.stub().callsFake(async (localPath, value, ack) => {
            createdStates[localPath] = { val: value, ack };
        }),
        delObjectAsync: sinon.stub().callsFake(async localPath => {
            deletedObjects.push(localPath);
        }),
        getAdapterObjectsAsync: sinon.stub().callsFake(async () => {
            return { ...objects };
        }),

        // Test helpers
        _createdObjects: createdObjects,
        _createdStates: createdStates,
        _deletedObjects: deletedObjects,
    };

    return adapter;
}

describe('migration', () => {
    describe('migrate() - LPC state migration', () => {
        it('should skip migration when no legacy LPC states exist under info', async () => {
            const adapter = createMockAdapter();

            await migrate(adapter);

            expect(adapter.extendObjectAsync.called).to.equal(false);
            expect(adapter.delObjectAsync.called).to.equal(false);
            expect(adapter.log.info.calledWithMatch(/migrating LPC states/)).to.equal(false);
        });

        it('should migrate all LPC states from info.* to LPC.*', async () => {
            const objects = {
                'eebus-go.0.info.state': { type: 'state', common: { name: 'State', type: 'string' }, native: {} },
                'eebus-go.0.info.limit': { type: 'state', common: { name: 'Limit', type: 'number' }, native: {} },
                'eebus-go.0.info.limitDuration': {
                    type: 'state',
                    common: { name: 'Limit Duration', type: 'number' },
                    native: {},
                },
                'eebus-go.0.info.limitMinutesToday': {
                    type: 'state',
                    common: { name: 'Limit Minutes Today', type: 'number' },
                    native: {},
                },
            };
            const states = {
                'info.state': { val: 'limited', ack: true },
                'info.limit': { val: 5000, ack: true },
                'info.limitDuration': { val: 30, ack: true },
                'info.limitMinutesToday': { val: 15, ack: true },
            };

            const adapter = createMockAdapter({ objects, states });

            await migrate(adapter);

            // Verify LPC folder was created
            expect(adapter._createdObjects['LPC']).to.deep.include({
                type: 'folder',
                common: { name: 'LPC' },
            });

            // Verify new state objects were created with correct common definitions
            expect(adapter._createdObjects['LPC.state']).to.deep.include({
                type: 'state',
                common: { name: 'State', type: 'string' },
            });
            expect(adapter._createdObjects['LPC.limit']).to.deep.include({
                type: 'state',
                common: { name: 'Limit', type: 'number' },
            });

            // Verify values were copied
            expect(adapter._createdStates['LPC.state']).to.deep.equal({ val: 'limited', ack: true });
            expect(adapter._createdStates['LPC.limit']).to.deep.equal({ val: 5000, ack: true });
            expect(adapter._createdStates['LPC.limitDuration']).to.deep.equal({ val: 30, ack: true });
            expect(adapter._createdStates['LPC.limitMinutesToday']).to.deep.equal({ val: 15, ack: true });

            // Verify old objects were deleted
            expect(adapter._deletedObjects).to.include('info.state');
            expect(adapter._deletedObjects).to.include('info.limit');
            expect(adapter._deletedObjects).to.include('info.limitDuration');
            expect(adapter._deletedObjects).to.include('info.limitMinutesToday');
        });

        it('should NOT migrate info.connection, info.discoveredDevices, or info.ski', async () => {
            const objects = {
                'eebus-go.0.info.state': { type: 'state', common: { name: 'State', type: 'string' }, native: {} },
                'eebus-go.0.info.connection': {
                    type: 'state',
                    common: { name: 'Connection', type: 'boolean' },
                    native: {},
                },
                'eebus-go.0.info.discoveredDevices': {
                    type: 'state',
                    common: { name: 'Discovered', type: 'string' },
                    native: {},
                },
                'eebus-go.0.info.ski': { type: 'state', common: { name: 'SKI', type: 'string' }, native: {} },
            };
            const states = {
                'info.state': { val: 'init', ack: true },
            };

            const adapter = createMockAdapter({ objects, states });

            await migrate(adapter);

            // Only info.state should be deleted, not connection/discoveredDevices/ski
            expect(adapter._deletedObjects).to.include('info.state');
            expect(adapter._deletedObjects).to.not.include('info.connection');
            expect(adapter._deletedObjects).to.not.include('info.discoveredDevices');
            expect(adapter._deletedObjects).to.not.include('info.ski');
        });

        it('should handle partial migration failure gracefully', async () => {
            const objects = {
                'eebus-go.0.info.state': { type: 'state', common: { name: 'State', type: 'string' }, native: {} },
                'eebus-go.0.info.limit': { type: 'state', common: { name: 'Limit', type: 'number' }, native: {} },
            };
            const states = {
                'info.state': { val: 'init', ack: true },
                'info.limit': { val: 1000, ack: true },
            };

            const adapter = createMockAdapter({ objects, states });

            // Make the first state migration fail
            let callCount = 0;
            adapter.extendObjectAsync = sinon.stub().callsFake(async (path, obj) => {
                callCount++;
                // Fail on the state object creation (2nd call, after LPC folder)
                if (path === 'LPC.state') {
                    throw new Error('Simulated failure');
                }
                adapter._createdObjects[path] = obj;
            });

            await migrate(adapter);

            // info.state migration should have failed, but info.limit should succeed
            expect(adapter.log.error.calledWithMatch(/failed to migrate info\.state/)).to.equal(true);
            // Limit should still be migrated
            expect(adapter._createdObjects['LPC.limit']).to.exist;
            expect(adapter._createdStates['LPC.limit']).to.deep.equal({ val: 1000, ack: true });
        });

        it('should skip individual states that do not exist', async () => {
            // Only info.state exists, not the others
            const objects = {
                'eebus-go.0.info.state': { type: 'state', common: { name: 'State', type: 'string' }, native: {} },
            };
            const states = {
                'info.state': { val: 'failsafe', ack: true },
            };

            const adapter = createMockAdapter({ objects, states });

            await migrate(adapter);

            // Only info.state should be migrated
            expect(adapter._createdStates['LPC.state']).to.deep.equal({ val: 'failsafe', ack: true });
            expect(adapter._deletedObjects).to.include('info.state');
            // Others should not be touched
            expect(adapter._deletedObjects).to.not.include('info.limit');
        });
    });

    describe('migrate() - Energy guard migration', () => {
        it('should skip guard migration when no old EnergyGuards exist', async () => {
            const adapter = createMockAdapter();

            await migrate(adapter);

            expect(adapter.log.info.calledWithMatch(/migrating.*energy guard/)).to.equal(false);
        });

        it('should migrate energy guards from EnergyGuards.Guard_* to LPC.EnergyGuards.Guard_*', async () => {
            const objects = {
                'eebus-go.0.EnergyGuards.Guard_WallBox': {
                    type: 'channel',
                    common: { name: 'WallBox' },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_WallBox.percentage': {
                    type: 'state',
                    common: { name: 'Percentage', type: 'number', min: 0, max: 100 },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_WallBox.failsafeLimit': {
                    type: 'state',
                    common: { name: 'Failsafe Limit', type: 'number', unit: 'W' },
                    native: {},
                },
            };
            const states = {
                'EnergyGuards.Guard_WallBox.percentage': { val: 75, ack: true },
                'EnergyGuards.Guard_WallBox.failsafeLimit': { val: 2000, ack: true },
            };

            const adapter = createMockAdapter({ objects, states });

            await migrate(adapter);

            // Verify new channel was created
            expect(adapter._createdObjects['LPC.EnergyGuards.Guard_WallBox']).to.deep.include({
                type: 'channel',
                common: { name: 'WallBox' },
            });

            // Verify state values were copied
            expect(adapter._createdStates['LPC.EnergyGuards.Guard_WallBox.percentage']).to.deep.equal({
                val: 75,
                ack: true,
            });
            expect(adapter._createdStates['LPC.EnergyGuards.Guard_WallBox.failsafeLimit']).to.deep.equal({
                val: 2000,
                ack: true,
            });

            // Verify old objects were deleted (children first, then channel)
            expect(adapter._deletedObjects).to.include('EnergyGuards.Guard_WallBox.percentage');
            expect(adapter._deletedObjects).to.include('EnergyGuards.Guard_WallBox.failsafeLimit');
            expect(adapter._deletedObjects).to.include('EnergyGuards.Guard_WallBox');
        });

        it('should migrate multiple energy guards', async () => {
            const objects = {
                'eebus-go.0.EnergyGuards.Guard_WallBox': {
                    type: 'channel',
                    common: { name: 'WallBox' },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_WallBox.percentage': {
                    type: 'state',
                    common: { name: 'Percentage', type: 'number' },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_HeatPump': {
                    type: 'channel',
                    common: { name: 'HeatPump' },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_HeatPump.failsafeLimit': {
                    type: 'state',
                    common: { name: 'Failsafe Limit', type: 'number' },
                    native: {},
                },
            };
            const states = {
                'EnergyGuards.Guard_WallBox.percentage': { val: 50, ack: true },
                'EnergyGuards.Guard_HeatPump.failsafeLimit': { val: 1500, ack: true },
            };

            const adapter = createMockAdapter({ objects, states });

            await migrate(adapter);

            // Both guards should be migrated
            expect(adapter._createdObjects['LPC.EnergyGuards.Guard_WallBox']).to.exist;
            expect(adapter._createdObjects['LPC.EnergyGuards.Guard_HeatPump']).to.exist;
            expect(adapter._createdStates['LPC.EnergyGuards.Guard_WallBox.percentage']).to.deep.equal({
                val: 50,
                ack: true,
            });
            expect(adapter._createdStates['LPC.EnergyGuards.Guard_HeatPump.failsafeLimit']).to.deep.equal({
                val: 1500,
                ack: true,
            });
        });

        it('should delete the old top-level EnergyGuards folder after migration', async () => {
            const objects = {
                'eebus-go.0.EnergyGuards.Guard_Test': {
                    type: 'channel',
                    common: { name: 'Test' },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_Test.percentage': {
                    type: 'state',
                    common: { name: 'Percentage', type: 'number' },
                    native: {},
                },
            };
            const states = {
                'EnergyGuards.Guard_Test.percentage': { val: 100, ack: true },
            };

            const adapter = createMockAdapter({ objects, states });

            await migrate(adapter);

            // EnergyGuards folder itself should be deleted
            expect(adapter._deletedObjects).to.include('EnergyGuards');
        });

        it('should not migrate objects under LPC.EnergyGuards or LPP.EnergyGuards paths', async () => {
            const objects = {
                'eebus-go.0.LPC.EnergyGuards.Guard_Existing': {
                    type: 'channel',
                    common: { name: 'Existing' },
                    native: {},
                },
                'eebus-go.0.LPP.EnergyGuards.Guard_Production': {
                    type: 'channel',
                    common: { name: 'Production' },
                    native: {},
                },
            };

            const adapter = createMockAdapter({ objects });

            await migrate(adapter);

            // Nothing should be migrated or deleted
            expect(adapter.log.info.calledWithMatch(/migrating.*energy guard/)).to.equal(false);
        });

        it('should handle individual guard migration failure and continue with remaining', async () => {
            const objects = {
                'eebus-go.0.EnergyGuards.Guard_Failing': {
                    type: 'channel',
                    common: { name: 'Failing' },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_Failing.percentage': {
                    type: 'state',
                    common: { name: 'Percentage', type: 'number' },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_Working': {
                    type: 'channel',
                    common: { name: 'Working' },
                    native: {},
                },
                'eebus-go.0.EnergyGuards.Guard_Working.percentage': {
                    type: 'state',
                    common: { name: 'Percentage', type: 'number' },
                    native: {},
                },
            };
            const states = {
                'EnergyGuards.Guard_Failing.percentage': { val: 25, ack: true },
                'EnergyGuards.Guard_Working.percentage': { val: 75, ack: true },
            };

            const adapter = createMockAdapter({ objects, states });

            // Make extending the Failing guard's channel throw
            const originalExtend = adapter.extendObjectAsync;
            adapter.extendObjectAsync = sinon.stub().callsFake(async (path, obj) => {
                if (path === 'LPC.EnergyGuards.Guard_Failing') {
                    throw new Error('Simulated guard failure');
                }
                adapter._createdObjects[path] = obj;
            });

            await migrate(adapter);

            // Failing guard should log error
            expect(adapter.log.error.calledWithMatch(/failed to migrate energy guard.*Guard_Failing/)).to.equal(true);
            // Working guard should still be migrated
            expect(adapter._createdObjects['LPC.EnergyGuards.Guard_Working']).to.exist;
        });
    });
});

const fc = require('fast-check');

describe('Feature: add-lpp-use-case, Property 7: Migration Preserves State Values', () => {
    /**
     * Validates: Requirements 10.3, 12.2
     *
     * For any set of existing ioBroker state objects at legacy paths
     * (info.state, info.limit, info.limitDuration, info.limitMinutesToday),
     * migration SHALL create equivalent objects at the new paths (LPC.*)
     * with identical values, and then delete the old objects.
     * info.connection, info.discoveredDevices, and info.ski are NOT touched.
     */
    it('migrated LPC states appear at new paths with identical values and old objects are deleted', async function () {
        this.timeout(30000);

        const stateArb = fc.constantFrom('init', 'unlimitedControlled', 'limited', 'failsafe', 'unlimitedAutonomous');
        const limitArb = fc.integer({ min: 0, max: 50000 });
        const limitDurationArb = fc.integer({ min: 0, max: 1440 });
        const limitMinutesTodayArb = fc.integer({ min: 0, max: 1440 });

        await fc.assert(
            fc.asyncProperty(
                stateArb,
                limitArb,
                limitDurationArb,
                limitMinutesTodayArb,
                async (stateVal, limitVal, limitDurationVal, limitMinutesTodayVal) => {
                    const objects = {
                        'eebus-go.0.info.state': {
                            type: 'state',
                            common: { name: 'State', type: 'string' },
                            native: {},
                        },
                        'eebus-go.0.info.limit': {
                            type: 'state',
                            common: { name: 'Limit', type: 'number' },
                            native: {},
                        },
                        'eebus-go.0.info.limitDuration': {
                            type: 'state',
                            common: { name: 'Limit Duration', type: 'number' },
                            native: {},
                        },
                        'eebus-go.0.info.limitMinutesToday': {
                            type: 'state',
                            common: { name: 'Limit Minutes Today', type: 'number' },
                            native: {},
                        },
                        // These should NOT be migrated
                        'eebus-go.0.info.connection': {
                            type: 'state',
                            common: { name: 'Connection', type: 'boolean' },
                            native: {},
                        },
                        'eebus-go.0.info.discoveredDevices': {
                            type: 'state',
                            common: { name: 'Discovered', type: 'string' },
                            native: {},
                        },
                        'eebus-go.0.info.ski': { type: 'state', common: { name: 'SKI', type: 'string' }, native: {} },
                    };
                    const states = {
                        'info.state': { val: stateVal, ack: true },
                        'info.limit': { val: limitVal, ack: true },
                        'info.limitDuration': { val: limitDurationVal, ack: true },
                        'info.limitMinutesToday': { val: limitMinutesTodayVal, ack: true },
                    };

                    const adapter = createMockAdapter({ objects, states });

                    await migrate(adapter);

                    // Verify new path objects have identical values
                    expect(adapter._createdStates['LPC.state']).to.deep.equal({ val: stateVal, ack: true });
                    expect(adapter._createdStates['LPC.limit']).to.deep.equal({ val: limitVal, ack: true });
                    expect(adapter._createdStates['LPC.limitDuration']).to.deep.equal({
                        val: limitDurationVal,
                        ack: true,
                    });
                    expect(adapter._createdStates['LPC.limitMinutesToday']).to.deep.equal({
                        val: limitMinutesTodayVal,
                        ack: true,
                    });

                    // Verify old objects were deleted
                    expect(adapter._deletedObjects).to.include('info.state');
                    expect(adapter._deletedObjects).to.include('info.limit');
                    expect(adapter._deletedObjects).to.include('info.limitDuration');
                    expect(adapter._deletedObjects).to.include('info.limitMinutesToday');

                    // Verify info.connection, info.discoveredDevices, info.ski were NOT touched
                    expect(adapter._deletedObjects).to.not.include('info.connection');
                    expect(adapter._deletedObjects).to.not.include('info.discoveredDevices');
                    expect(adapter._deletedObjects).to.not.include('info.ski');
                },
            ),
            { numRuns: 100 },
        );
    });
});
