-- Keep the denormalized pointer version consistent with its lifecycle row.
CREATE TRIGGER IF NOT EXISTS material_current_consistent_insert
BEFORE INSERT ON material_current
WHEN NEW.version != (SELECT version FROM material_versions WHERE id=NEW.material_version_id)
BEGIN SELECT RAISE(ABORT, 'material_current version mismatch'); END;
