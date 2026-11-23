CREATE TABLE IF NOT EXISTS transit_option (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    loan_id bigint NOT NULL REFERENCES exhibit_loan,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    vehicle text NOT NULL,
    begins_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > begins_at),
    expected_rh integer NOT NULL CHECK (expected_rh BETWEEN 0 AND 100),
    transfers integer NOT NULL CHECK (transfers BETWEEN 0 AND 8),
    status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'booked', 'superseded')),
    risk text CHECK (risk IN ('low', 'high')),
    probability double precision CHECK (probability BETWEEN 0 AND 1),
    conflict_reason text,
    note text,
    batch_digest text NOT NULL,
    recorded_by text NOT NULL REFERENCES staff,
    recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_option_history ON transit_option (loan_id, status, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS booked_option_per_loan ON transit_option (loan_id)
    WHERE status = 'booked';

ALTER TABLE transit_window ADD COLUMN IF NOT EXISTS option_id bigint
    REFERENCES transit_option(id) ON DELETE SET NULL;
