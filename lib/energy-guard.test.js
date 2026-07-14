'use strict';

const chai = require('chai');
const sinonChai = require('sinon-chai');
const sinon = require('sinon');
const { EebusEnergyGuard, ManualEnergyGuard } = require('./energy-guard');

chai.use(sinonChai);
const { expect } = chai;

/**
 * Create a mock ioBroker adapter with stubbed async methods.
 */
function createMockAdapter() {
    return {
        extendObjectAsync: sinon.stub().resolves(),
        setStateAsync: sinon.stub().resolves(),
        getStateAsync: sinon.stub().resolves(null),
        log: {
            debug: sinon.stub(),
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
        },
    };
}

describe('BaseEnergyGuard (via EebusEnergyGuard)', () => {
    let adapter;
    let guard;

    beforeEach(() => {
        adapter = createMockAdapter();
        guard = new EebusEnergyGuard(adapter, 'TestGuard', 'abc123def456', 60);
    });

    describe('calculateLimit()', () => {
        it('should return effectivePct * contractMax / 100 when greater than failsafeLimit', () => {
            // failsafeLimit defaults to 0, so 50% of 32000 = 16000
            const result = guard.calculateLimit(32000, 50);
            expect(result).to.equal(16000);
        });

        it('should return failsafeLimit when it exceeds the percentage-based calculation', async () => {
            await guard.setFailsafeLimit(5000);
            const result = guard.calculateLimit(32000, 10);
            expect(result).to.equal(5000);
        });

        it('should return failsafeLimit when effectivePct is 0', async () => {
            await guard.setFailsafeLimit(4200);
            const result = guard.calculateLimit(32000, 0);
            expect(result).to.equal(4200);
        });

        it('should return contractMax when effectivePct is 100 and failsafeLimit is small', async () => {
            await guard.setFailsafeLimit(100);
            const result = guard.calculateLimit(32000, 100);
            expect(result).to.equal(32000);
        });
    });

    describe('createObjects()', () => {
        it('should create channel and all base state objects', async () => {
            await guard.createObjects();

            // Channel + percentage + currentLimit + limitActive + lastHeartbeat + failsafeLimit + eebusConnected = 7 calls
            expect(adapter.extendObjectAsync.callCount).to.equal(7);

            const paths = adapter.extendObjectAsync.args.map(args => args[0]);
            expect(paths).to.include('EnergyGuards.Guard_TestGuard');
            expect(paths).to.include('EnergyGuards.Guard_TestGuard.percentage');
            expect(paths).to.include('EnergyGuards.Guard_TestGuard.currentLimit');
            expect(paths).to.include('EnergyGuards.Guard_TestGuard.limitActive');
            expect(paths).to.include('EnergyGuards.Guard_TestGuard.lastHeartbeat');
            expect(paths).to.include('EnergyGuards.Guard_TestGuard.failsafeLimit');
            expect(paths).to.include('EnergyGuards.Guard_TestGuard.eebusConnected');
        });

        it('should set percentage as writable with role=level', async () => {
            await guard.createObjects();

            const pctCall = adapter.extendObjectAsync.args.find(a => a[0].endsWith('.percentage'));
            expect(pctCall[1].common.write).to.equal(true);
            expect(pctCall[1].common.role).to.equal('level');
            expect(pctCall[1].common.def).to.equal(0);
        });
    });

    describe('applyLimit()', () => {
        it('should store the calculated limit and set limitActive=true', async () => {
            await guard.applyLimit(32000, 50);

            expect(guard.currentLimit).to.equal(16000);
            expect(guard.limitActive).to.equal(true);
            expect(adapter.setStateAsync).to.have.been.calledWith(
                'EnergyGuards.Guard_TestGuard.currentLimit',
                16000,
                true,
            );
            expect(adapter.setStateAsync).to.have.been.calledWith(
                'EnergyGuards.Guard_TestGuard.limitActive',
                true,
                true,
            );
        });
    });

    describe('deactivateLimit()', () => {
        it('should set limitActive=false and currentLimit=0', async () => {
            await guard.applyLimit(32000, 50);
            await guard.deactivateLimit();

            expect(guard.currentLimit).to.equal(0);
            expect(guard.limitActive).to.equal(false);
            expect(adapter.setStateAsync).to.have.been.calledWith('EnergyGuards.Guard_TestGuard.currentLimit', 0, true);
            expect(adapter.setStateAsync).to.have.been.calledWith(
                'EnergyGuards.Guard_TestGuard.limitActive',
                false,
                true,
            );
        });
    });

    describe('getPercentage()', () => {
        it('should return the percentage value from ioBroker state', async () => {
            adapter.getStateAsync.resolves({ val: 75 });
            const pct = await guard.getPercentage();
            expect(pct).to.equal(75);
        });

        it('should return 0 if state is null', async () => {
            adapter.getStateAsync.resolves(null);
            const pct = await guard.getPercentage();
            expect(pct).to.equal(0);
        });

        it('should return 0 if getStateAsync throws', async () => {
            adapter.getStateAsync.rejects(new Error('fail'));
            const pct = await guard.getPercentage();
            expect(pct).to.equal(0);
        });
    });

    describe('updateHeartbeat()', () => {
        it('should set lastHeartbeat state with a timestamp', async () => {
            const before = Date.now();
            await guard.updateHeartbeat();
            const after = Date.now();

            const call = adapter.setStateAsync.args.find(a => a[0].endsWith('.lastHeartbeat'));
            expect(call).to.exist;
            expect(call[1]).to.be.at.least(before);
            expect(call[1]).to.be.at.most(after);
        });
    });
});

describe('EebusEnergyGuard', () => {
    let adapter;
    let guard;

    beforeEach(() => {
        adapter = createMockAdapter();
        guard = new EebusEnergyGuard(adapter, 'WallBox', 'ski123456789012345678901234567890abcdef01', 60);
    });

    it('should return configured SKI via getter', () => {
        expect(guard.ski).to.equal('ski123456789012345678901234567890abcdef01');
    });

    describe('setConnected()', () => {
        it('should not set connected=true if no heartbeat received', async () => {
            await guard.setConnected(true);
            expect(guard.isConnected()).to.equal(false);
            expect(adapter.setStateAsync).to.not.have.been.called;
        });

        it('should set connected=false regardless of heartbeat state', async () => {
            await guard.setConnected(false);
            expect(guard.isConnected()).to.equal(false);
            expect(adapter.setStateAsync).to.have.been.calledWith(
                'EnergyGuards.Guard_WallBox.eebusConnected',
                false,
                true,
            );
        });

        it('should set connected=true after heartbeat is received', async () => {
            await guard.handleHeartbeat();
            expect(guard.isConnected()).to.equal(true);
        });
    });

    describe('handleHeartbeat()', () => {
        it('should mark as connected and update heartbeat timestamp', async () => {
            await guard.handleHeartbeat();
            expect(guard.isConnected()).to.equal(true);
            const hbCall = adapter.setStateAsync.args.find(a => a[0].endsWith('.lastHeartbeat'));
            expect(hbCall).to.exist;
        });
    });

    describe('unassignUseCaseClient()', () => {
        it('should reset connection state and heartbeat flag', async () => {
            await guard.handleHeartbeat();
            expect(guard.isConnected()).to.equal(true);

            await guard.unassignUseCaseClient();
            expect(guard.isConnected()).to.equal(false);
        });

        it('should prevent setConnected(true) after unassign until new heartbeat', async () => {
            await guard.handleHeartbeat();
            await guard.unassignUseCaseClient();
            await guard.setConnected(true);
            expect(guard.isConnected()).to.equal(false);
        });
    });

    describe('assignUseCaseClient()', () => {
        it('should not throw when assigning a client', () => {
            const fakeClient = {};
            expect(() => guard.assignUseCaseClient(fakeClient)).to.not.throw();
        });
    });
});

describe('ManualEnergyGuard', () => {
    let adapter;
    let guard;

    beforeEach(() => {
        adapter = createMockAdapter();
        guard = new ManualEnergyGuard(adapter, 'HeatPump', 60);
    });

    describe('createObjects()', () => {
        it('should create base states plus heartbeat and connected states', async () => {
            await guard.createObjects();

            // Channel + percentage + currentLimit + limitActive + lastHeartbeat + failsafeLimit(base) + failsafeLimit(writable override) + heartbeat + connected = 9 calls
            expect(adapter.extendObjectAsync.callCount).to.equal(9);

            const paths = adapter.extendObjectAsync.args.map(args => args[0]);
            expect(paths).to.include('EnergyGuards.Guard_HeatPump.heartbeat');
            expect(paths).to.include('EnergyGuards.Guard_HeatPump.connected');
            expect(paths).to.include('EnergyGuards.Guard_HeatPump.failsafeLimit');
        });

        it('should set heartbeat as writable with role=button', async () => {
            await guard.createObjects();

            const hbCall = adapter.extendObjectAsync.args.find(a => a[0].endsWith('.heartbeat'));
            expect(hbCall[1].common.write).to.equal(true);
            expect(hbCall[1].common.role).to.equal('button');
            expect(hbCall[1].common.type).to.equal('boolean');
        });

        it('should set connected as writable with role=indicator.connected', async () => {
            await guard.createObjects();

            const connCall = adapter.extendObjectAsync.args.find(a => a[0].endsWith('.connected'));
            expect(connCall[1].common.write).to.equal(true);
            expect(connCall[1].common.role).to.equal('indicator.connected');
            expect(connCall[1].common.type).to.equal('boolean');
        });
    });

    describe('onHeartbeatWrite()', () => {
        it('should update the heartbeat timestamp', async () => {
            await guard.onHeartbeatWrite();
            const hbCall = adapter.setStateAsync.args.find(a => a[0].endsWith('.lastHeartbeat'));
            expect(hbCall).to.exist;
        });
    });

    describe('onConnectedWrite()', () => {
        it('should update connection state to true', async () => {
            await guard.onConnectedWrite(true);
            expect(guard.isConnected()).to.equal(true);
            expect(adapter.setStateAsync).to.have.been.calledWith('EnergyGuards.Guard_HeatPump.connected', true, true);
        });

        it('should update connection state to false', async () => {
            await guard.onConnectedWrite(true);
            await guard.onConnectedWrite(false);
            expect(guard.isConnected()).to.equal(false);
        });
    });

    describe('isConnected()', () => {
        it('should return false initially', () => {
            expect(guard.isConnected()).to.equal(false);
        });
    });
});
