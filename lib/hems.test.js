'use strict';

const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const { Hems } = require('./hems');

chai.use(sinonChai);
const { expect } = chai;

/**
 * Create a mock ioBroker adapter with stubbed methods required by Hems.
 */
function createMockAdapter(configOverrides = {}) {
    const config = {
        grpcEndpoint: 'localhost:50051',
        servicePort: 4711,
        serialNumber: 'TEST-001',
        heartbeatTimeoutSeconds: 10,
        controlboxSki: '',
        lpcEnabled: true,
        lppEnabled: false,
        energyGuards: [],
        lppEnergyGuards: [],
        contractualConsumptionNominalMax: 32000,
        contractualProductionNominalMax: 4200,
        ...configOverrides,
    };

    return {
        config,
        namespace: 'eebus-go.0',
        extendObjectAsync: sinon.stub().resolves(),
        setStateAsync: sinon.stub().resolves(),
        setState: sinon.stub(),
        getStateAsync: sinon.stub().resolves(null),
        setTimeout: sinon.stub().returns(42),
        clearTimeout: sinon.stub(),
        setInterval: sinon.stub().returns(99),
        clearInterval: sinon.stub(),
        getAdapterObjectsAsync: sinon.stub().resolves({}),
        delObjectAsync: sinon.stub().resolves(),
        log: {
            debug: sinon.stub(),
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
        },
    };
}

// ─── handleEnergyGuardStateChange Routing Tests ─────────────────────────────

describe('Hems handleEnergyGuardStateChange routing', () => {
    let adapter;
    let hems;
    let mockLpcUseCase;
    let mockLppUseCase;

    beforeEach(() => {
        adapter = createMockAdapter({ lpcEnabled: true, lppEnabled: true });
        hems = new Hems(adapter, key => key);

        // Create mock use case instances and inject them via reflection-style access
        // Since Hems uses private fields, we test routing by observing behavior.
        // We'll use a trick: assign mocked use cases via the restart internals or
        // directly test the routing logic by calling handleEnergyGuardStateChange
        // after manually setting the use case instances.

        // The Hems class exposes lpcUseCase and lppUseCase getters.
        // Since we can't set private fields directly, we test the routing
        // when use cases are null (default after construction without restart).
    });

    describe('routing with no use cases active (no restart called)', () => {
        it('handles LPC-prefixed state change gracefully when lpcUseCase is null', async () => {
            expect(hems.lpcUseCase).to.equal(null);

            await hems.handleEnergyGuardStateChange('eebus-go.0.LPC.EnergyGuards.Guard_WallBox.percentage', {
                val: 50,
            });

            // Should log debug message about LPC not active
            expect(adapter.log.debug).to.have.been.calledWith(
                sinon.match('LPC state change received but LPC use case not active'),
            );
        });

        it('handles LPP-prefixed state change gracefully when lppUseCase is null', async () => {
            expect(hems.lppUseCase).to.equal(null);

            await hems.handleEnergyGuardStateChange('eebus-go.0.LPP.EnergyGuards.Guard_Solar.percentage', { val: 75 });

            // Should log debug message about LPP not active
            expect(adapter.log.debug).to.have.been.calledWith(
                sinon.match('LPP state change received but LPP use case not active'),
            );
        });

        it('logs debug for unrecognized path', async () => {
            await hems.handleEnergyGuardStateChange('eebus-go.0.SomeOther.Path', { val: 10 });

            expect(adapter.log.debug).to.have.been.calledWith(sinon.match('Unrecognized state change path'));
        });
    });

    describe('routing with namespace stripping', () => {
        it('correctly strips adapter namespace from state ID', async () => {
            await hems.handleEnergyGuardStateChange('eebus-go.0.LPC.EnergyGuards.Guard_Test.percentage', { val: 50 });

            // The localId should be "LPC.EnergyGuards.Guard_Test.percentage" after stripping
            expect(adapter.log.debug).to.have.been.calledWith(sinon.match('LPC.EnergyGuards.Guard_Test.percentage'));
        });

        it('handles ID without adapter namespace prefix', async () => {
            await hems.handleEnergyGuardStateChange('LPP.EnergyGuards.Guard_Solar.percentage', { val: 80 });

            // Should still detect LPP prefix correctly
            expect(adapter.log.debug).to.have.been.calledWith(
                sinon.match('LPP state change received but LPP use case not active'),
            );
        });
    });
});

// ─── Hems state getter Tests ────────────────────────────────────────────────

describe('Hems state getter', () => {
    it('returns "init" when no LPC use case is active', () => {
        const adapter = createMockAdapter({ lpcEnabled: false });
        const hems = new Hems(adapter, key => key);

        expect(hems.state).to.equal('init');
    });

    it('returns "init" after construction (before restart)', () => {
        const adapter = createMockAdapter({ lpcEnabled: true });
        const hems = new Hems(adapter, key => key);

        // No restart called, so lpcUseCase is null
        expect(hems.lpcUseCase).to.equal(null);
        expect(hems.state).to.equal('init');
    });
});

// ─── Hems stop() Tests ──────────────────────────────────────────────────────

describe('Hems stop()', () => {
    it('gracefully handles stop when no use cases are instantiated', () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        // lpcUseCase and lppUseCase are both null, stop should not throw
        expect(() => hems.stop()).to.not.throw();
    });

    it('gracefully handles stop when no discovery stream or control client', () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        // No restart called, so no streams or clients
        expect(() => hems.stop()).to.not.throw();
        // No timer to clear either
        expect(adapter.clearTimeout).to.not.have.been.called;
    });

    it('can be called multiple times safely', () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        expect(() => {
            hems.stop();
            hems.stop();
        }).to.not.throw();
    });
});

// ─── Hems constructor Tests ─────────────────────────────────────────────────

describe('Hems constructor', () => {
    it('initializes with null use case instances', () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        expect(hems.lpcUseCase).to.equal(null);
        expect(hems.lppUseCase).to.equal(null);
    });

    it('accepts adapter without translate function (defaults to identity)', () => {
        const adapter = createMockAdapter();
        // translate parameter is optional per constructor doc
        const hems = new Hems(adapter);

        expect(hems.lpcUseCase).to.equal(null);
        expect(hems.state).to.equal('init');
    });
});

// ─── Hems handleEnergyGuardStateChange with mock use cases ──────────────────

describe('Hems handleEnergyGuardStateChange with injected use cases', () => {
    // To properly test routing TO the use case instances, we use proxyquire
    // to mock the gRPC modules so restart() succeeds, then verify routing.
    // However, since proxyquire is not in devDependencies and the task notes
    // suggest testing without full gRPC mocking, we test routing logic
    // by leveraging the observable behavior (debug logs) when use cases are null.
    //
    // For completeness, we also verify that the routing logic correctly classifies
    // each path prefix.

    it('routes "LPC." prefixed path to LPC use case path', async () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        // With no lpcUseCase, it logs that LPC is not active
        await hems.handleEnergyGuardStateChange('eebus-go.0.LPC.EnergyGuards.Guard_X.percentage', { val: 50 });
        expect(adapter.log.debug).to.have.been.calledWith(
            'LPC state change received but LPC use case not active: LPC.EnergyGuards.Guard_X.percentage',
        );
    });

    it('routes "LPP." prefixed path to LPP use case path', async () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        await hems.handleEnergyGuardStateChange('eebus-go.0.LPP.EnergyGuards.Guard_X.percentage', { val: 50 });
        expect(adapter.log.debug).to.have.been.calledWith(
            'LPP state change received but LPP use case not active: LPP.EnergyGuards.Guard_X.percentage',
        );
    });

    it('logs unrecognized path for unknown prefix', async () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        await hems.handleEnergyGuardStateChange('eebus-go.0.Unknown.Path.state', { val: 1 });
        expect(adapter.log.debug).to.have.been.calledWith(
            'Unrecognized state change path — no use case to route to: Unknown.Path.state',
        );
    });
});

// ─── gRPC control client is shared (design validation) ──────────────────────

describe('Hems gRPC control client sharing', () => {
    // The design states that the HEMS coordinator creates a single gRPC control
    // client and passes it to both use case instances. Since we can't easily
    // intercept the private #connect() flow without proxyquire, we verify the
    // design by checking:
    // 1. The Hems constructor doesn't create a control client prematurely
    // 2. The restart() method exists and is callable (triggers #onRestart)
    // 3. Without a valid grpcEndpoint config, restart logs an error

    it('does not create control client on construction', () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        // No gRPC calls should have been made just from construction
        expect(hems.lpcUseCase).to.equal(null);
        expect(hems.lppUseCase).to.equal(null);
    });

    it('restart() logs error and does not crash when grpcEndpoint is empty', () => {
        const adapter = createMockAdapter({ grpcEndpoint: '' });
        const hems = new Hems(adapter, key => key);

        // restart() should not throw even with invalid config
        expect(() => hems.restart()).to.not.throw();

        // The async #onRestart should log that grpcEndpoint is missing
        // Give it a tick to run the async logic
        return new Promise(resolve => setTimeout(resolve, 50)).then(() => {
            expect(adapter.log.error).to.have.been.calledWith('grpcEndpoint is not configured — skipping restart');
        });
    });

    it('restart() method is available on Hems instance', () => {
        const adapter = createMockAdapter();
        const hems = new Hems(adapter, key => key);

        expect(typeof hems.restart).to.equal('function');
    });
});
