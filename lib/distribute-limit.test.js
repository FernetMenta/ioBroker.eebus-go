'use strict';

const fc = require('fast-check');
const { expect } = require('chai');
const { distributeLimit: distributeLimitLpc } = require('./eg-lpc');
const { distributeLimit: distributeLimitLpp } = require('./eg-lpp');

// Both functions share the same algorithm — test them together.
for (const [label, distributeLimit] of [
    ['eg-lpc distributeLimit', distributeLimitLpc],
    ['eg-lpp distributeLimit', distributeLimitLpp],
]) {
    describe(label, () => {
        it('returns empty array for empty guards', () => {
            expect(distributeLimit(10000, [])).to.deep.equal([]);
        });

        it('single guard gets the full budget', () => {
            const result = distributeLimit(10000, [{ pct: 50, failsafeLimit: 0 }]);
            expect(result[0]).to.be.closeTo(10000, 1);
        });

        it('two equal guards split evenly', () => {
            const result = distributeLimit(10000, [
                { pct: 50, failsafeLimit: 0 },
                { pct: 50, failsafeLimit: 0 },
            ]);
            expect(result[0]).to.be.closeTo(5000, 1);
            expect(result[1]).to.be.closeTo(5000, 1);
        });

        it('normalizes percentages when sum > 100%', () => {
            const result = distributeLimit(10000, [
                { pct: 80, failsafeLimit: 0 },
                { pct: 80, failsafeLimit: 0 },
            ]);
            // 80+80=160 → scale=100/160, each effectively 50% → 5000W
            expect(result[0]).to.be.closeTo(5000, 1);
            expect(result[1]).to.be.closeTo(5000, 1);
        });

        it('pins guard at failsafe when percentage share is too low', () => {
            const result = distributeLimit(10000, [{ pct: 10, failsafeLimit: 5000 }]);
            // 10% of 10000 = 1000 < failsafe 5000 → pinned at 5000
            expect(result[0]).to.equal(5000);
        });

        it('pinning reduces budget for remaining guards', () => {
            const result = distributeLimit(10000, [
                { pct: 10, failsafeLimit: 4000 }, // 10% of 10000=1000 < 4000 → pinned
                { pct: 90, failsafeLimit: 0 },
            ]);
            // Guard 0 pinned at 4000, remaining budget = 6000, guard 1 gets all of it
            expect(result[0]).to.equal(4000);
            expect(result[1]).to.be.closeTo(6000, 1);
        });

        it('floors all results at 1W minimum', () => {
            const result = distributeLimit(10000, [{ pct: 0, failsafeLimit: 0 }]);
            expect(result[0]).to.equal(1);
        });

        it('property: every guard gets at least its failsafe limit', function () {
            this.timeout(30000);

            const guardArb = fc.record({
                pct: fc.float({ min: 0, max: 200, noNaN: true }),
                failsafeLimit: fc.float({ min: 0, max: 5000, noNaN: true }),
            });

            fc.assert(
                fc.property(
                    fc.float({ min: 1, max: 50000, noNaN: true }),
                    fc.array(guardArb, { minLength: 1, maxLength: 8 }),
                    (budget, guards) => {
                        const result = distributeLimit(budget, guards);
                        for (let i = 0; i < guards.length; i++) {
                            expect(result[i]).to.be.at.least(
                                guards[i].failsafeLimit,
                                `Guard ${i}: ${result[i]} < failsafe ${guards[i].failsafeLimit}`,
                            );
                        }
                    },
                ),
                { numRuns: 200 },
            );
        });

        it('property: every guard gets at least 1W', function () {
            this.timeout(30000);

            const guardArb = fc.record({
                pct: fc.float({ min: 0, max: 200, noNaN: true }),
                failsafeLimit: fc.float({ min: 0, max: 5000, noNaN: true }),
            });

            fc.assert(
                fc.property(
                    fc.float({ min: 1, max: 50000, noNaN: true }),
                    fc.array(guardArb, { minLength: 1, maxLength: 8 }),
                    (budget, guards) => {
                        const result = distributeLimit(budget, guards);
                        for (let i = 0; i < guards.length; i++) {
                            expect(result[i]).to.be.at.least(1);
                        }
                    },
                ),
                { numRuns: 200 },
            );
        });

        it('property: result length equals guards length', function () {
            this.timeout(30000);

            const guardArb = fc.record({
                pct: fc.float({ min: 0, max: 200, noNaN: true }),
                failsafeLimit: fc.float({ min: 0, max: 5000, noNaN: true }),
            });

            fc.assert(
                fc.property(
                    fc.float({ min: 1, max: 50000, noNaN: true }),
                    fc.array(guardArb, { minLength: 1, maxLength: 8 }),
                    (budget, guards) => {
                        const result = distributeLimit(budget, guards);
                        expect(result.length).to.equal(guards.length);
                    },
                ),
                { numRuns: 100 },
            );
        });
    });
}
