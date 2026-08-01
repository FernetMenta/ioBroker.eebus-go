// This file extends the AdapterConfig type from "@iobroker/types"
// using the actual properties present in io-package.json
// in order to provide typings for adapter.config properties

import { native } from '../io-package.json';

type _AdapterConfig = typeof native;

export interface EnergyGuardConfig {
    name: string;
    type: 'eebus' | 'manual';
    ski: string;
    brand: string;
}

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig extends _AdapterConfig {
            lpcEnabled: boolean;
            lppEnabled: boolean;
            contractualProductionNominalMax: number;
            energyGuards: EnergyGuardConfig[];
            lppEnergyGuards: EnergyGuardConfig[];
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
