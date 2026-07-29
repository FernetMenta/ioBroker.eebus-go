# Setup of iobroker.eebus-grpc container

EEBUS communication uses mDNS (multicast DNS) to discover devices on the network. Make sure that all EEBUS devices you want to communicate with are on the same subnet.

There are two options for docker networks that can be used with mDNS. Either you attach the container directly to the host network or better use a macvlan as shown below.

## Example for docker-compose

```
services:
  eebus-grpc:
    image: fernetmenta/iobroker.eebus-grpc:latest
    container_name: eebus-grpc
    restart: unless-stopped
    environment:
      # This is the GRPC Server bind address in the docker bridge network
      IPV4_ADDR: 172.30.0.10
      CRT_PATH: "/certs/myhems_cert"
      KEY_PATH: "/certs/myhems_key"
      GRPC_PORT: 50051
      # Possible values: trace, debug, info, error
      LOG_LEVEL: info
    networks:
      internal:
        ipv4_address: 172.30.0.10
      lan:
        ipv4_address: 192.168.178.221
    # adopt to your UID/GID
    user: 1000:1000

    volumes:
      - ./certs:/certs

    healthcheck:
      test: ["CMD-SHELL", "grpc-health-probe -addr=$${IPV4_ADDR}:50051 || pkill -u $$(id -u)"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 10s

  iobroker:
    container_name: iobroker
    image: buanet/iobroker
    hostname: iobroker
    restart: always
    depends_on:
      eebus-grpc:
        condition: service_healthy
    networks:
      internal:
        ipv4_address: 172.30.0.11
      lan:
        ipv4_address: 192.168.178.220
    ports:
      - "8081:8081"
    volumes:
      - ./iobrokerdata:/opt/iobroker
    environment:
      - TZ=Europe/Berlin
networks:
  internal:
    driver: bridge
    ipam:
      config:
        - subnet: 172.30.0.0/24
          gateway: 172.30.0.1
          ip_range: 172.30.0.0/24

  lan:
    driver: macvlan
    driver_opts:
      parent: enp3s0
    ipam:
      config:
        - subnet: 192.168.178.0/24
          gateway: 192.168.178.1
          ip_range: 192.168.178.216/29
```

Note parameter IPV4_ADDR. In this example the result is that the gRPC server only binds to the internal network address. Hence the server is not reachable from outside the docker network.

**Important:** In the ioBroker adapter settings, set `grpcEndpoint` to `172.30.0.10:50051` (the container's internal bridge IP) since both containers share the `internal` network. Using `localhost:50051` would not work in this setup.

If you want to reach containers on the macvlan from the host, you have to set up an additional IP link on the host. To make this persistent you can set up a systemd service that creates the link on startup.

```
ip link add mac0 link enp3s0 type macvlan mode bridge
ip addr add 192.168.178.222/32 dev mac0
ip link set mac0 up
```

## Run command for quick test on host network

Run grpc server (certs will be created automatically in the specified certs directory if not exist!)

```bash
mkdir certs
docker run --rm -it \
  --network=host \
  -v "$PWD/certs:/certs" \
  -e LOG_LEVEL=debug \
  fernetmenta/iobroker.eebus-grpc:latest
```

The entrypoint uses these environment variables (with their Dockerfile defaults):

| Variable    | Default              | Description                          |
| ----------- | -------------------- | ------------------------------------ |
| `IPV4_ADDR` | `0.0.0.0`            | gRPC server bind address             |
| `CRT_PATH`  | `/certs/myhems_cert` | Path to certificate                  |
| `KEY_PATH`  | `/certs/myhems_key`  | Path to private key                  |
| `GRPC_PORT` | `50051`              | gRPC server port                     |
| `LOG_LEVEL` | `info`               | Log level: trace, debug, info, error |
