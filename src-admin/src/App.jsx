import React, { Suspense } from 'react';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';

import AppBar from '@mui/material/AppBar';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';

import { GenericApp, Router, Loader, I18n } from '@iobroker/gui-components';

import en from './i18n/en.json';
import de from './i18n/de.json';
import ru from './i18n/ru.json';
import pt from './i18n/pt.json';
import nl from './i18n/nl.json';
import fr from './i18n/fr.json';
import it from './i18n/it.json';
import es from './i18n/es.json';
import pl from './i18n/pl.json';
import uk from './i18n/uk.json';
import zhCn from './i18n/zh-cn.json';

const TabBaseConfig = React.lazy(() => import('./Tabs/BaseConfig'));
const TabEnergyGuards = React.lazy(() => import('./Tabs/EnergyGuardsConfig'));
const TabLppEnergyGuards = React.lazy(() => import('./Tabs/LppEnergyGuardsConfig'));

const styles = {
    root: {},
    tabContent: {
        p: 5,
        height: 'calc(100% - 64px - 48px - 20px)',
        overflow: 'auto',
    },
    tabContentIFrame: {
        padding: 5,
        height: 'calc(100% - 64px - 48px - 20px - 38px)',
        overflow: 'auto',
    },
};

/**
 * Base class for the admin UI
 */
class App extends GenericApp {
    /**
     * @param {object} props - react properties including 'adapterName'
     */
    constructor(props) {
        const extendedProps = { ...props };
        extendedProps.encryptedFields = ['pass']; // this parameter will be encrypted and decrypted automatically
        extendedProps.translations = {
            en,
            de,
            ru,
            pt,
            nl,
            fr,
            it,
            es,
            pl,
            uk,
            'zh-cn': zhCn,
        };
        // get actual admin port
        extendedProps.socket = { port: parseInt(window.location.port, 10) };

        // Only if close, save buttons are not required at the bottom (e.g. if admin tab)
        // extendedProps.bottomButtons = false;

        // only for debug purposes
        if (extendedProps.socket.port === 3000) {
            extendedProps.socket.port = 8081;
        }

        // allow to manage GenericApp the sentry initialisation or do not set the sentryDSN if no sentry available
        extendedProps.sentryDSN = 'https://yyy@sentry.iobroker.net/xx';

        super(props, extendedProps);
    }

    /**
     * Returns the list of visible tab names based on current configuration.
     */
    getVisibleTabs() {
        const tabs = ['config'];
        if (this.state.native && this.state.native.lpcEnabled !== false) {
            tabs.push('energyguards');
        }
        if (this.state.native && this.state.native.lppEnabled) {
            tabs.push('lppengergyguards');
        }
        return tabs;
    }

    /**
     * returns index of selected tab
     */
    getSelectedTab() {
        const tab = this.state.selectedTab;
        const visibleTabs = this.getVisibleTabs();
        const index = visibleTabs.indexOf(tab);
        return index >= 0 ? index : 0;
    }

    /**
     * renders an AppBar with Tabs
     */
    renderTabsForConfig() {
        return (
            <>
                <AppBar position="static">
                    <Tabs
                        value={this.getSelectedTab()}
                        onChange={e => Router.doNavigate(e.target.dataset.name)}
                        textColor="secondary"
                        indicatorColor="secondary"
                    >
                        <Tab
                            label={I18n.t('Base Config')}
                            data-name="config"
                        />
                        {this.state.native.lpcEnabled !== false && (
                            <Tab
                                label={I18n.t('LPC Energy Guards')}
                                data-name="energyguards"
                            />
                        )}
                        {this.state.native && this.state.native.lppEnabled && (
                            <Tab
                                label={I18n.t('LPP Energy Guards')}
                                data-name="lppengergyguards"
                            />
                        )}
                    </Tabs>
                </AppBar>

                <Suspense>
                    <Box
                        component="div"
                        sx={{ ...(this.isIFrame ? styles.tabContentIFrame : styles.tabContent) }}
                    >
                        {(this.state.selectedTab === 'config' || !this.state.selectedTab) && (
                            <TabBaseConfig
                                key="config"
                                common={this.common}
                                socket={this.socket}
                                native={this.state.native}
                                onError={text =>
                                    this.setState({
                                        errorText:
                                            (text || text === 0) && typeof text !== 'string' ? text.toString() : text,
                                    })
                                }
                                onLoad={native => this.onLoadConfig(native)}
                                instance={this.instance}
                                adapterName={this.adapterName}
                                changed={this.state.changed}
                                onChange={(attr, value, cb) => this.updateNativeValue(attr, value, cb)}
                            />
                        )}
                        {this.state.selectedTab === 'energyguards' && this.state.native.lpcEnabled !== false && (
                            <TabEnergyGuards
                                key="energyguards"
                                common={this.common}
                                socket={this.socket}
                                native={this.state.native}
                                onError={text =>
                                    this.setState({
                                        errorText:
                                            (text || text === 0) && typeof text !== 'string' ? text.toString() : text,
                                    })
                                }
                                onLoad={native => this.onLoadConfig(native)}
                                instance={this.instance}
                                adapterName={this.adapterName}
                                changed={this.state.changed}
                                onChange={(attr, value, cb) => this.updateNativeValue(attr, value, cb)}
                            />
                        )}
                        {this.state.selectedTab === 'lppengergyguards' &&
                            this.state.native &&
                            this.state.native.lppEnabled && (
                                <TabLppEnergyGuards
                                    key="lppengergyguards"
                                    common={this.common}
                                    socket={this.socket}
                                    native={this.state.native}
                                    onError={text =>
                                        this.setState({
                                            errorText:
                                                (text || text === 0) && typeof text !== 'string'
                                                    ? text.toString()
                                                    : text,
                                        })
                                    }
                                    onLoad={native => this.onLoadConfig(native)}
                                    instance={this.instance}
                                    adapterName={this.adapterName}
                                    changed={this.state.changed}
                                    onChange={(attr, value, cb) => this.updateNativeValue(attr, value, cb)}
                                />
                            )}
                    </Box>
                </Suspense>
                {this.renderSaveCloseButtons()}
            </>
        );
    }

    /**
     * renders this component
     */
    render() {
        if (!this.state.loaded) {
            return (
                <StyledEngineProvider injectFirst>
                    <ThemeProvider theme={this.state.theme}>
                        <Loader themeType={this.state.themeType} />
                    </ThemeProvider>
                </StyledEngineProvider>
            );
        }

        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>
                    <div
                        className="App"
                        style={{
                            background: this.state.theme.palette.background.default,
                            color: this.state.theme.palette.text.primary,
                        }}
                    >
                        {!this.isTab ? this.renderTabsForConfig() : this.renderEventList()}
                        {this.renderError()}
                    </div>
                </ThemeProvider>
            </StyledEngineProvider>
        );
    }
}

export default App;
