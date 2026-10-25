CREATE TABLE IF NOT EXISTS subscription_devices (
  subscription_key TEXT NOT NULL,
  hwid TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  device_os TEXT,
  device_model TEXT,
  user_agent TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_ip TEXT,
  PRIMARY KEY (subscription_key, hwid),
  UNIQUE (subscription_key, device_ref)
);

CREATE INDEX IF NOT EXISTS idx_subscription_devices_key
  ON subscription_devices(subscription_key, last_seen);
