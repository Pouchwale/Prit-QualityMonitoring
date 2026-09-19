-- A "Photo" parameter type: the worker's answer is a photo (e.g. Ink Photo), not a typed value.
-- Additive only; existing parameters, check types and submissions are unchanged.
ALTER TYPE "public"."parameter_type" ADD VALUE IF NOT EXISTS 'PHOTO';
