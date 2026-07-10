import React, { Component } from 'react';
import PropTypes from 'prop-types';

import {
    Button,
    Box,
    Dialog,
    DialogTitle,
    DialogContent,
    List,
    ListItemButton,
    ListItemText,
    DialogActions,
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { I18n } from '@iobroker/adapter-react-v5';

const styles = {
    tab: {
        width: '100%',
        minHeight: '100%',
    },
    column: {
        display: 'inline-block',
        verticalAlign: 'top',
        marginRight: 20,
    },
    columnSettings: {
        width: 'calc(100% - 10px)',
    },
};

/**
 * Class for configuring Energy Guards (add/remove EEBUS and Manual guards)
 */
class EnergyGuardsConfig extends Component {
    /**
     * @param {object} props - properties set when the component gets created
     */
    constructor(props) {
        super(props);

        this.state = {
            energyGuards: props.native.energyGuards || [],
            discoveredDevices: props.native.discoveredDevices || {},
            rowSelectionModel: [],
            addEebusDialogOpen: false,
        };

        this.adapterObjectId = `system.adapter.${this.props.adapterName}.${this.props.instance}`;

        this.columns = [
            { field: 'name', headerName: I18n.t('Name'), minWidth: 150, flex: 1, editable: true },
            { field: 'type', headerName: I18n.t('Type'), minWidth: 100, flex: 1 },
            { field: 'brand', headerName: I18n.t('Brand'), minWidth: 100, flex: 1 },
            { field: 'ski', headerName: 'SKI', minWidth: 350, flex: 2 },
        ];
    }

    /**
     * Called by React when component was mounted
     */
    componentDidMount() {
        // Subscribe to adapter object changes to detect discoveredDevices updates
        this.props.socket.subscribeObject(this.adapterObjectId, this.onObjectChanged);
    }

    /**
     * Called by React before component will unmount.
     */
    componentWillUnmount() {
        this.props.socket.unsubscribeObject(this.adapterObjectId, this.onObjectChanged);
    }

    onObjectChanged = (id, obj) => {
        if (id === this.adapterObjectId && obj && obj.native && obj.native.discoveredDevices) {
            this.setState({ discoveredDevices: obj.native.discoveredDevices });
        }
    };

    /**
     * Get energy guards as array for DataGrid rows.
     *
     * @returns {Array} rows
     */
    getGuardRows() {
        const guards = this.props.native.energyGuards || [];
        return guards.map((guard, index) => ({
            id: index,
            name: guard.name || '',
            type: guard.type || '',
            brand: guard.brand || '',
            ski: guard.ski || '',
        }));
    }

    /**
     * Opens the discovered devices selection dialog for adding an EEBUS guard.
     */
    handleAddEebus = () => {
        this.setState({ addEebusDialogOpen: true });
    };

    /**
     * Appends a new manual guard entry and calls props.onChange.
     */
    handleAddManual = () => {
        const guards = [...(this.props.native.energyGuards || [])];
        guards.push({ name: '', type: 'manual', ski: '', brand: '' });
        this.props.onChange('energyGuards', guards);
    };

    /**
     * Removes the selected guard from the array and calls props.onChange.
     */
    handleRemove = () => {
        const selected = this.state.rowSelectionModel;
        if (selected.length === 0) {
            return;
        }
        const guards = [...(this.props.native.energyGuards || [])];
        // rowSelectionModel contains the row id (index)
        const indexToRemove = selected[0];
        guards.splice(indexToRemove, 1);
        this.setState({ rowSelectionModel: [] });
        this.props.onChange('energyGuards', guards);
    };

    /**
     * Handles selection of a discovered device from the dialog.
     * Creates a new EEBUS guard entry with device info and closes the dialog.
     *
     * @param {object} device - the discovered device object
     */
    handleSelectDiscoveredDevice = device => {
        const guards = [...(this.props.native.energyGuards || [])];
        guards.push({
            name: device.model || '',
            type: 'eebus',
            ski: device.remoteSki || '',
            brand: device.brand || '',
        });
        this.setState({ addEebusDialogOpen: false });
        this.props.onChange('energyGuards', guards);
    };

    /**
     * Handles inline editing of the name column in the DataGrid.
     *
     * @param {object} newRow - the updated row data
     * @param {object} oldRow - the original row data
     * @returns {object} the updated row
     */
    processRowUpdate = (newRow, oldRow) => {
        if (newRow.name !== oldRow.name) {
            const guards = [...(this.props.native.energyGuards || [])];
            guards[newRow.id] = { ...guards[newRow.id], name: newRow.name };
            this.props.onChange('energyGuards', guards);
        }
        return newRow;
    };

    /**
     * Renders the component
     */
    render() {
        const rows = this.getGuardRows();
        const devices = this.state.discoveredDevices || {};
        const deviceList = Object.values(devices);

        return (
            <form style={{ ...styles.tab }}>
                <div style={{ ...styles.column, ...styles.columnSettings }}>
                    <h3>{I18n.t('Energy Guards')}</h3>
                    <Box sx={{ height: 400, width: '100%' }}>
                        <DataGrid
                            rows={rows}
                            columns={this.columns}
                            rowHeight={36}
                            rowSelectionModel={this.state.rowSelectionModel}
                            onRowSelectionModelChange={newSelection =>
                                this.setState({ rowSelectionModel: newSelection })
                            }
                            processRowUpdate={this.processRowUpdate}
                        />
                    </Box>
                    <Box sx={{ marginTop: 1, display: 'flex', gap: 1 }}>
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={this.handleAddEebus}
                        >
                            {I18n.t('Add EEBUS')}
                        </Button>
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={this.handleAddManual}
                        >
                            {I18n.t('Add Manual')}
                        </Button>
                        <Button
                            variant="contained"
                            color="secondary"
                            disabled={this.state.rowSelectionModel.length === 0}
                            onClick={this.handleRemove}
                        >
                            {I18n.t('Remove')}
                        </Button>
                    </Box>
                </div>

                {/* Dialog for selecting a discovered device when adding EEBUS guard */}
                <Dialog
                    open={this.state.addEebusDialogOpen}
                    onClose={() => this.setState({ addEebusDialogOpen: false })}
                    maxWidth="sm"
                    fullWidth
                >
                    <DialogTitle>{I18n.t('Select Discovered Device')}</DialogTitle>
                    <DialogContent>
                        {deviceList.length === 0 ? (
                            <Box sx={{ padding: 2 }}>{I18n.t('No discovered devices available')}</Box>
                        ) : (
                            <List>
                                {deviceList.map(device => (
                                    <ListItemButton
                                        key={device.remoteSki}
                                        onClick={() => this.handleSelectDiscoveredDevice(device)}
                                    >
                                        <ListItemText
                                            primary={`${device.brand || ''} ${device.model || ''}`}
                                            secondary={device.remoteSki || ''}
                                        />
                                    </ListItemButton>
                                ))}
                            </List>
                        )}
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => this.setState({ addEebusDialogOpen: false })}>{I18n.t('Cancel')}</Button>
                    </DialogActions>
                </Dialog>
            </form>
        );
    }
}

EnergyGuardsConfig.propTypes = {
    common: PropTypes.object.isRequired,
    native: PropTypes.object.isRequired,
    instance: PropTypes.number.isRequired,
    adapterName: PropTypes.string.isRequired,
    onError: PropTypes.func,
    onLoad: PropTypes.func,
    onChange: PropTypes.func,
    changed: PropTypes.bool,
    socket: PropTypes.object.isRequired,
};

export default EnergyGuardsConfig;
