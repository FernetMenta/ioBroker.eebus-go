'use strict';

const fc = require('fast-check');
const chai = require('chai');
const sinon = require('sinon');
const {
    LpcUseCase,
    LPC_STATE,
    LPC_TRANSITIONS,
    shouldApproveLimit,
    distributeConsumptionLimit,
} = require('./lpc-use-case');

const { expect } = chai;

/**
 * Create a mock ioBroker adapter with stubbed methods required by LpcUseCase.
 */
function createMockAdapter() {
    return {
        extendObjectAsync: sinon.stub().resolves(),
        setStateAsync: sinon.stub().resolves(),
        setState: sinon.stub(),
        getStateAsync: sinon.stub().resolves(null),
        setTimeout: sinon.stub().returns(42),
        clearTimeout: sinon.stub(),
        setInterval: sinon.stub().returns(99),
        clearInterval: sinon.stub(),
        log: {
            debug: sinon.stub(),
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
        },
    };
}

/**
 * Build a path map: for each state, find a sequence of transitions from init
 * that reaches that state. Used to set up the FSM before testing a specific transition.
 */
function buildPathsFromInit() {
    const paths = {};
    paths[LPC_STATE.INIT] = [];

    const nonWildcardTransitions = LPC_TRANSITIONS.filter(t => t.from !== '*');

    const queue = [LPC_STATE.INIT];
    const visited = new Set([LPC_STATE.INIT]);

    while (queue.length > 0) {
        const current = queue.shift();
        const outgoing = nonWildcardTransitions.filter(t => t.from === current);

        for (const t of outgoing) {
            if (!visited.has(t.to)) {
                visited.add(t.to);
                paths[t.to] = [...paths[current], t.name];
                queue.push(t.to);
            }
        }
    }

    return paths;
}

const PATHS_FROM_INIT = buildPathsFromInit();

/**
 * Navigate a fresh LpcUseCase instance to the given target state
 * by triggering a pre-computed sequence of transitions from init.
 */
function navigateToState(lpc, targetState) {
    if (targetState === '*') {
        return;
    }
    const path = PATHS_FROM_INIT[targetState];
    if (!path) {
        throw new Error(`No path from init to state: ${targetState}`);
    }
    for (const transitionName of path) {
        const result = lpc.trigger(transitionName);
        if (!result) {
            throw new Error(`Failed to trigger transition '${transitionName}' while navigating to '${targetState}'`);
        }
    }
}

// Filter transitions for the property test:
const concreteTransitions = LPC_TRANSITIONS.filter(t => t.from !== '*');
const wildcardTransitions = LPC_TRANSITIONS.filter(t => t.from === '*');
const allStates = Object.values(LPC_STATE);

// Expand wildcard transitions into concrete (state, transition) pairs
const expandedTransitions = [
    ...concreteTransitions,
    ...wildcardTransitions.flatMap(t => allStates.map(state => ({ name: t.name, from: state, to: t.to }))),
];

// ─── FSM Transition Tests ────────────────────────────────────────────────────

describe('LpcUseCase FSM Transitions', () => {
    it('every valid (state, transition) pair produces the correct target state', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(fc.constantFrom(...expandedTransitions), transition => {
                const adapter = createMockAdapter();
                const config = {};
                const controlClient = {};
                const translate = key => key;
                const lpc = new LpcUseCase(adapter, config, controlClient, translate);

                navigateToState(lpc, transition.from);
                expect(lpc.state).to.equal(transition.from);

                const result = lpc.trigger(transition.name);
                expect(result).to.equal(true);
                expect(lpc.state).to.equal(transition.to);
            }),
            { numRuns: 100 },
        );
    });

    it('the state property always reflects the current FSM state after any valid transition', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(fc.constantFrom(...expandedTransitions), transition => {
                const adapter = createMockAdapter();
                const lpc = new LpcUseCase(adapter, {}, {}, key => key);

                navigateToState(lpc, transition.from);
                lpc.trigger(transition.name);
                expect(lpc.state).to.equal(transition.to);
            }),
            { numRuns: 100 },
        );
    });

    it('invalid transitions return false and do not change state', () => {
        const adapter = createMockAdapter();
        const lpc = new LpcUseCase(adapter, {}, {}, key => key);

        // From init, limitDurationExpired is not a valid transition
        expect(lpc.state).to.equal(LPC_STATE.INIT);
        const result = lpc.trigger('limitDurationExpired');
        expect(result).to.equal(false);
        expect(lpc.state).to.equal(LPC_STATE.INIT);
    });

    it('restart from any state always returns to init', () => {
        const adapter = createMockAdapter();
        const lpc = new LpcUseCase(adapter, {}, {}, key => key);

        for (const state of allStates) {
            navigateToState(lpc, state);
            expect(lpc.state).to.equal(state);
            const result = lpc.trigger('restart');
            expect(result).to.equal(true);
            expect(lpc.state).to.equal(LPC_STATE.INIT);
        }
    });
});

// ─── Timer Management Tests ──────────────────────────────────────────────────

describe('LpcUseCase Timer Management', () => {
    it('init timer starts on construction (init state)', () => {
        const adapter = createMockAdapter();
        new LpcUseCase(adapter, {}, {}, key => key);

        // The constructor initializes the FSM in init state, which triggers onEnterState
        // and starts the init timer via adapter.setTimeout
        expect(adapter.setTimeout.called).to.equal(true);
    });

    it('init timer is cleared when leaving init state', () => {
        const adapter = createMockAdapter();
        const lpc = new LpcUseCase(adapter, {}, {}, key => key);

        // Transition out of init
        lpc.trigger('heartbeatDeactivatedLimit');
        expect(lpc.state).to.equal(LPC_STATE.UNLIMITED_CONTROLLED);
        expect(adapter.clearTimeout.called).to.equal(true);
    });

    it('failsafe timer starts when entering failsafe state (async, triggers callUnary)', async () => {
        const adapter = createMockAdapter();
        const lpc = new LpcUseCase(adapter, {}, {}, key => key);

        // Navigate to failsafe (init → unlimitedControlled → failsafe)
        lpc.trigger('heartbeatDeactivatedLimit');
        adapter.setTimeout.resetHistory();

        lpc.trigger('heartbeatTimeout');
        expect(lpc.state).to.equal(LPC_STATE.FAILSAFE);

        // The failsafe timer is async (reads FailsafeDurationMinimum via callUnary)
        // Since there's no real CS-LPC client, it will catch the error and still call setTimeout with default 2h
        // Wait a tick for the async onEnterState to settle
        await new Promise(resolve => setTimeout(resolve, 50));

        // After the async call completes (or errors), setTimeout should be called
        expect(adapter.setTimeout.called).to.equal(true);
    });

    it('restart triggers init timer again', () => {
        const adapter = createMockAdapter();
        const lpc = new LpcUseCase(adapter, {}, {}, key => key);

        // Move to a non-init state
        lpc.trigger('heartbeatDeactivatedLimit');
        adapter.setTimeout.resetHistory();

        // Restart back to init
        lpc.trigger('restart');
        expect(lpc.state).to.equal(LPC_STATE.INIT);
        // Init timer should start again
        expect(adapter.setTimeout.called).to.equal(true);
    });

    it('clearTimeout is called when transitioning from init (init timer cleared)', () => {
        const adapter = createMockAdapter();
        const lpc = new LpcUseCase(adapter, {}, {}, key => key);

        // Init timer was started, now clear history
        adapter.clearTimeout.resetHistory();

        // Leave init → clears init timer
        lpc.trigger('heartbeatActivatedLimit');
        expect(lpc.state).to.equal(LPC_STATE.LIMITED);
        expect(adapter.clearTimeout.called).to.equal(true);
    });
});

// ─── shouldApproveLimit Tests ────────────────────────────────────────────────

describe('LpcUseCase shouldApproveLimit', () => {
    it('approves when pendingLimit >= sum of failsafe limits', () => {
        expect(shouldApproveLimit(10000, [3000, 2000, 1000])).to.equal(true);
        expect(shouldApproveLimit(6000, [3000, 2000, 1000])).to.equal(true);
    });

    it('denies when pendingLimit < sum of failsafe limits', () => {
        expect(shouldApproveLimit(5999, [3000, 2000, 1000])).to.equal(false);
        expect(shouldApproveLimit(0, [1000])).to.equal(false);
    });

    it('approves when no guards are configured (empty array)', () => {
        expect(shouldApproveLimit(0, [])).to.equal(true);
        expect(shouldApproveLimit(5000, [])).to.equal(true);
    });

    it('approves iff pendingLimit >= sum(guardFailsafeLimits) (property test)', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(
                fc.array(fc.float({ min: 0, max: 10000, noNaN: true }), { minLength: 0, maxLength: 10 }),
                fc.float({ min: 0, max: 50000, noNaN: true }),
                (guardFailsafeLimits, pendingLimit) => {
                    const failsafeSum = guardFailsafeLimits.reduce((sum, limit) => sum + limit, 0);
                    const result = shouldApproveLimit(pendingLimit, guardFailsafeLimits);

                    if (pendingLimit >= failsafeSum) {
                        expect(result).to.equal(true);
                    } else {
                        expect(result).to.equal(false);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── distributeConsumptionLimit Tests ────────────────────────────────────────

describe('LpcUseCase distributeConsumptionLimit', () => {
    it('returns empty array when no guards provided', () => {
        const result = distributeConsumptionLimit(10000, []);
        expect(result).to.deep.equal([]);
    });

    it('disconnected guards are skipped (skip=true)', () => {
        const guards = [
            { pct: 50, connected: true, failsafeLimit: 0 },
            { pct: 50, connected: false, failsafeLimit: 1000 },
        ];
        const results = distributeConsumptionLimit(10000, guards);

        expect(results[0].skip).to.equal(false);
        expect(results[1].skip).to.equal(true);
    });

    it('scales percentages if sum exceeds 100%', () => {
        const guards = [
            { pct: 80, connected: true, failsafeLimit: 0 },
            { pct: 80, connected: true, failsafeLimit: 0 },
        ];
        const results = distributeConsumptionLimit(10000, guards);

        // 80 + 80 = 160 > 100, so scale factor = 100/160 = 0.625
        // Each gets 80*0.625 = 50 effective pct → 5000W
        expect(results[0].effectiveLimit).to.be.closeTo(5000, 1);
        expect(results[1].effectiveLimit).to.be.closeTo(5000, 1);
    });

    it('effective limit is at least the failsafe limit', () => {
        const guards = [{ pct: 10, connected: true, failsafeLimit: 5000 }];
        const results = distributeConsumptionLimit(10000, guards);

        // 10% of 10000 = 1000, but failsafe is 5000 → pinned at 5000
        expect(results[0].effectiveLimit).to.equal(5000);
    });

    it('disconnected guards do not redistribute shares to connected guards', () => {
        const guards = [
            { pct: 50, connected: true, failsafeLimit: 0 },
            { pct: 50, connected: false, failsafeLimit: 0 },
        ];
        const results = distributeConsumptionLimit(10000, guards);

        // Guard 0 is connected and gets its 50% of total = 5000W (no redistribution)
        expect(results[0].effectiveLimit).to.be.closeTo(5000, 1);
        expect(results[1].skip).to.equal(true);
    });

    it('property: disconnected guards have skip=true, connected guards have skip=false', function () {
        this.timeout(30000);

        const guardArb = fc.record({
            pct: fc.float({ min: 0, max: 200, noNaN: true }),
            connected: fc.boolean(),
            failsafeLimit: fc.float({ min: 0, max: 5000, noNaN: true }),
        });

        fc.assert(
            fc.property(
                fc.float({ min: 1, max: 50000, noNaN: true }),
                fc.array(guardArb, { minLength: 1, maxLength: 8 }),
                (totalLimit, guards) => {
                    const results = distributeConsumptionLimit(totalLimit, guards);

                    for (let i = 0; i < guards.length; i++) {
                        if (!guards[i].connected) {
                            expect(results[i].skip).to.equal(true);
                        } else {
                            expect(results[i].skip).to.equal(false);
                        }
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it('property: each connected guard effectiveLimit >= their failsafeLimit', function () {
        this.timeout(30000);

        const guardArb = fc.record({
            pct: fc.float({ min: 0, max: 200, noNaN: true }),
            connected: fc.boolean(),
            failsafeLimit: fc.float({ min: 0, max: 5000, noNaN: true }),
        });

        fc.assert(
            fc.property(
                fc.float({ min: 1, max: 50000, noNaN: true }),
                fc.array(guardArb, { minLength: 1, maxLength: 8 }),
                (totalLimit, guards) => {
                    const results = distributeConsumptionLimit(totalLimit, guards);

                    for (let i = 0; i < guards.length; i++) {
                        if (guards[i].connected) {
                            expect(results[i].effectiveLimit).to.be.at.least(guards[i].failsafeLimit);
                        }
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it('property: result array length equals input guards length', function () {
        this.timeout(30000);

        const guardArb = fc.record({
            pct: fc.float({ min: 0, max: 200, noNaN: true }),
            connected: fc.boolean(),
            failsafeLimit: fc.float({ min: 0, max: 5000, noNaN: true }),
        });

        fc.assert(
            fc.property(
                fc.float({ min: 1, max: 50000, noNaN: true }),
                fc.array(guardArb, { minLength: 1, maxLength: 8 }),
                (totalLimit, guards) => {
                    const results = distributeConsumptionLimit(totalLimit, guards);
                    expect(results.length).to.equal(guards.length);
                },
            ),
            { numRuns: 100 },
        );
    });
});
