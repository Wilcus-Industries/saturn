-- One-off, idempotent migration for the if-node port rename.
--
-- The if node's operand value-input ports were renamed a -> l and b -> r. Port
-- ids are stored inside saved graph edges (edge.to.portId), so any existing if
-- node's incoming operand edges must be rewritten. This only touches edges
-- whose TARGET node is an `if` node (and/or nodes also use a/b ports and must
-- be left alone). Re-running is a no-op: after the rewrite no if-target edge
-- has portId a/b, so the WHERE EXISTS guard matches nothing.
--
-- Run: psql "$DATABASE_URL" -f db/migrate_if_ports.sql

UPDATE workflow w
SET graph = jsonb_set(
    w.graph,
    '{edges}',
    (
        SELECT coalesce(
            jsonb_agg(
                CASE
                    WHEN e->'to'->>'portId' IN ('a', 'b')
                        AND (
                            SELECT n->>'type'
                            FROM jsonb_array_elements(w.graph->'nodes') AS n
                            WHERE n->>'id' = e->'to'->>'nodeId'
                            LIMIT 1
                        ) = 'if'
                    THEN jsonb_set(
                        e,
                        '{to,portId}',
                        to_jsonb(CASE e->'to'->>'portId' WHEN 'a' THEN 'l' ELSE 'r' END)
                    )
                    ELSE e
                END
                ORDER BY ord
            ),
            '[]'::jsonb
        )
        FROM jsonb_array_elements(w.graph->'edges') WITH ORDINALITY AS t(e, ord)
    )
)
WHERE w.graph ? 'edges'
    AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(w.graph->'edges') AS e
        JOIN jsonb_array_elements(w.graph->'nodes') AS n
            ON n->>'id' = e->'to'->>'nodeId'
        WHERE e->'to'->>'portId' IN ('a', 'b')
            AND n->>'type' = 'if'
    );
