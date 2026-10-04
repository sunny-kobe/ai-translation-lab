-- Additive migration: historical metadata stays NULL (unknown).
ALTER TABLE translation_jobs ADD COLUMN provider text;
ALTER TABLE translation_jobs ADD COLUMN model text;
ALTER TABLE translation_jobs ADD COLUMN prompt_version text;
CREATE TABLE translation_calls (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES translation_jobs(id),
 source_key text NOT NULL,
 provider text NOT NULL,
 model text,
 prompt_version text NOT NULL,
 languages jsonb NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','partial','failed','interrupted','discarded')),
 error_code text,
 usage jsonb,
 estimated_cost_yuan numeric,
 price_basis text,
 duration_ms integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
ALTER TABLE translation_results ADD COLUMN call_id uuid REFERENCES translation_calls(id);
ALTER TABLE translation_results ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE translation_attempts ADD COLUMN call_id uuid REFERENCES translation_calls(id);
CREATE INDEX due_results ON translation_results (status,next_attempt_at,job_id,source_key);
CREATE TABLE worker_runtime (
 id integer PRIMARY KEY CHECK(id=1),
 cooldown_until timestamptz NOT NULL DEFAULT now()
);
INSERT INTO worker_runtime(id) VALUES(1);
