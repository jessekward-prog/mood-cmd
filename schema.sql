CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per check-in. Each period carries one extra score: morning sleep,
-- afternoon calm, night connection. The other two stay NULL.
CREATE TABLE IF NOT EXISTS entries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  period     TEXT NOT NULL CHECK (period IN ('morn', 'arvo', 'night')),
  mood       SMALLINT NOT NULL CHECK (mood BETWEEN 1 AND 10),
  energy     SMALLINT NOT NULL CHECK (energy BETWEEN 1 AND 10),
  sleep      SMALLINT CHECK (sleep BETWEEN 1 AND 10),
  calm       SMALLINT CHECK (calm BETWEEN 1 AND 10),
  connection SMALLINT CHECK (connection BETWEEN 1 AND 10),
  pos        TEXT NOT NULL,
  neg        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_ts ON entries (ts);

CREATE TABLE IF NOT EXISTS reports (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  days      SMALLINT NOT NULL,
  n         INT NOT NULL,
  model     TEXT,
  text      TEXT NOT NULL,
  support   BOOLEAN NOT NULL DEFAULT FALSE,
  scheduled BOOLEAN NOT NULL DEFAULT FALSE
);
