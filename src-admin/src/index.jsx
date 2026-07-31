import React from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import App from './App';
import packageInfo from '../package.json';

console.log(`iobroker.eebus-go@${packageInfo.version}`);

function build() {
    const container = document.getElementById('root');
    const root = createRoot(container);
    root.render(<App adapterName="eebus-go" />);
}

build();
