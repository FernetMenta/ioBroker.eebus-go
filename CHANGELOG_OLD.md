# Older changes
## 1.1.1 (2026-08-20)

- Fix: adapter admin UI does not meet the ioBroker responsive design initiative requirements
- Fix: refactor subscribeCsLpcEvents and signal stream errors to caller
- Fix: drop console.log in grpc-service.js
- Fix: German strings / logging in grpc-service.js
- Update README with note on docker on Windows

## 1.1.0 (2026-08-19)

- Feature: automatic backup and restore of Docker volume certificates — certs are saved to the adapter data directory on connection and restored to the volume on adapter start, ensuring they survive ioBroker backup/restore cycles
- Check if docker is available and make admin UI options available on this.
- Update depencendy on eebus-grpc

## 1.0.0 (2026-08-17)

- Breaking: requires eebus-grpc container image version 2.0.0 (`fernetmenta/iobroker.eebus-grpc:2.0.0`). The gRPC API changed to a single-server architecture with instance-based routing — use cases no longer spawn separate gRPC servers.
- Feature: integrate ioBroker plugin-docker to automatically manage the eebus-grpc container (pull, start, stop, update) — enable via "Enable Docker Container" checkbox on Base Config tab (requires Docker Engine >= 20.10 on the host)
- Fix: reset info.connection state to false on adapter unload

## 0.3.2 (2026-08-14)

- Fix: reduce log spam on manual energy guards — require 2 consecutive missed heartbeats before marking disconnected, downgrade routine heartbeat logs to debug level
- Fix: suppress error-level logs and reconnect attempts when adapter is shutting down (gRPC stream CANCELLED is expected during stop)
- Add an example of a manual LPC guard to the doc folder.
- Fix: translations
- Various smaller fixes.

## 0.3.1 (2026-08-09)

- Fix: reduce log spam from repeated failsafe/duration updates — only log and report to controlbox when values actually change
- Fix: deactivate energy guard limits when limit duration expires (limitDurationExpired transition)

## 0.3.0 (2026-08-07)

- Fix: set eebusConnected=true on UseCaseSupportUpdate (devices like PLENTICORE reject heartbeat subscriptions); reset heartbeat timer on any use case event to keep guard alive
- Fix: use correct gRPC RPC names for LPP energy guards (WriteProductionLimit / WriteFailsafeProductionActivePowerLimit instead of Consumption variants)
- Fix: do not report failsafe limit to controlbox before remote device confirms the write
- Feature: add writable failsafeDuration state (seconds) to EEBUS energy guards — reads from and writes to the remote device
- Feature: call StartHeartbeat on EG client so the remote CS can detect disconnection and enter failsafe
- Feature: handle Scenario 4 (DataUpdatePowerConsumptionNominalMax / DataUpdatePowerProductionNominalMax) for LPC and LPP energy guards — writes nominal max power to ioBroker objects

## 0.2.2 (2026-08-05)

- Fix: properly clean up resources before reconnect and propagate CS registration errors
- Fix: close events channel on use case server Stop() in eebus-grpc (unblock SubscribeUseCaseEvents on reset)
- Chore: clean up admin folder and build pipeline (remove CRA boilerplate, add exec plugin for release builds)

## 0.2.1 (2026-08-04)

- Refactor: rename grpc-cslpc.js to grpc-client.js (serves both LPC and LPP)
- Fix: correct invalid state roles (level.power → level, indicator.connected write flag)
- Fix: trigger full reconnect on gRPC transport errors instead of silently skipping failed operations

## 0.2.0 (2026-08-03)

- Refactor: separate EG (Energy Guard) handling from CS (Controllable System) use cases into eg-lpc.js / eg-lpp.js
- Fix: report dynamic failsafe limit to controlbox (sum of guard failsafes, reject user writes exceeding contractual max)
- Fix: distribute failsafe limits to energy guards when entering failsafe state
- Fix: only process controlbox heartbeats for FSM transitions (ignore EG device heartbeats)
- Fix: add periodic heartbeat check timer to detect controlbox disconnection
- Fix: recover FSM from unlimitedAutonomous when controlbox reconnects
- UI: allow clearing ControlBox SKI in admin config

## 0.1.0 (2026-08-01)

- (FernetMenta) Add LPP (Limitation of Power Production) use case
- (FernetMenta) Fix race condition in limit distribution (use stored limit value)
- (FernetMenta) Fix budget-respecting limit distribution: percentages are hard caps, no redistribution of disconnected shares, failsafe of disconnected guards reserved from budget
- (FernetMenta) UI: place contractual nominal max fields next to use case checkboxes
- (ioBroker-Bot) Adapter requires admin >= 7.8.23 now.

## 0.0.5 (2026-07-29)

- some fixes

## 0.0.4 (2026-07-29)

- fixes required by iobroker checker

## 0.0.3 (2026-07-29)

- fixes for repo checker

## 0.0.2 (2026-07-29)

- (FernetMenta) initial release
