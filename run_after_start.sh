#!/bin/bash

CONFIG_FILE="/config/configuration.yaml"

# Wait for 30 seconds
sleep 30

# Add development_repo if not present
if ! grep -q "development_repo: /usr/src/homeassistant/frontend/" "$CONFIG_FILE"; then
    echo "Adding development_repo to frontend section in configuration.yaml."
    sed -i '/frontend:/a \ \ development_repo: /usr/src/homeassistant/frontend/' "$CONFIG_FILE"
fi

# this is for demo