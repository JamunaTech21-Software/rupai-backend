-- AlterTable
ALTER TABLE `field` ADD COLUMN `boundary` JSON NULL,
    ADD COLUMN `centroid_latitude` DECIMAL(9, 6) NULL,
    ADD COLUMN `centroid_longitude` DECIMAL(9, 6) NULL,
    ADD COLUMN `mapped_area_acres` DECIMAL(14, 3) NULL,
    ADD COLUMN `perimeter_km` DECIMAL(10, 3) NULL;

-- AlterTable
ALTER TABLE `section` ADD COLUMN `boundary` JSON NULL,
    ADD COLUMN `mapped_area_acres` DECIMAL(14, 3) NULL;

-- HAND-EDIT: CHECK constraints (prisma/README.md). The geometry itself is validated by the service
-- (core/geo): a CHECK cannot judge a ring. These keep the computed figures consistent with it.
ALTER TABLE `field`
  -- The computed figures exist exactly when a boundary does (the service writes them together).
  ADD CONSTRAINT `ck_field_boundary_figures` CHECK (
    (`boundary` IS NULL) = (`centroid_latitude` IS NULL)
    AND (`centroid_latitude` IS NULL) = (`centroid_longitude` IS NULL)
    AND (`boundary` IS NULL) = (`perimeter_km` IS NULL)
    AND (`boundary` IS NOT NULL OR `mapped_area_acres` IS NULL)),
  ADD CONSTRAINT `ck_field_boundary_type` CHECK (
    `boundary` IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(`boundary`, '$.type')) IN ('Polygon', 'LineString')),
  -- Bangladesh, with a margin: 20.3–26.9 N, 87.9–92.9 E.
  ADD CONSTRAINT `ck_field_centroid` CHECK (
    `centroid_latitude` IS NULL OR (`centroid_latitude` BETWEEN 20.3 AND 26.9 AND `centroid_longitude` BETWEEN 87.9 AND 92.9)),
  ADD CONSTRAINT `ck_field_figures_positive` CHECK (
    (`perimeter_km` IS NULL OR `perimeter_km` >= 0) AND (`mapped_area_acres` IS NULL OR `mapped_area_acres` >= 0));
ALTER TABLE `section`
  ADD CONSTRAINT `ck_section_boundary` CHECK (
    (`boundary` IS NULL) = (`mapped_area_acres` IS NULL)
    AND (`boundary` IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(`boundary`, '$.type')) = 'Polygon'));
-- No new grant: field and section already have UPDATE for the app account.
