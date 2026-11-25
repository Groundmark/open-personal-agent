#!/bin/sh
# Prints a one-time link and QR code to set up the passkey that approves the agent's requests.
exec incus exec opa -- runuser -u opa-broker -- node /opt/opa/broker/src/main.js enroll /etc/opa/broker.json
