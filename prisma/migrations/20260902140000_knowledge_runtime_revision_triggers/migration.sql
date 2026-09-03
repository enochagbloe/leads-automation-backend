-- Keep cache revisions in the same transaction as every runtime-source mutation.
CREATE FUNCTION "bumpKnowledgeRuntimeRevision"() RETURNS trigger AS $$
DECLARE tenant_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN tenant_id := OLD."businessId";
  ELSE tenant_id := NEW."businessId";
  END IF;
  UPDATE "Business" SET "knowledgeRuntimeRevision" = "knowledgeRuntimeRevision" + 1
    WHERE "id" = tenant_id;
  IF TG_OP = 'UPDATE' AND OLD."businessId" IS DISTINCT FROM NEW."businessId" THEN
    UPDATE "Business" SET "knowledgeRuntimeRevision" = "knowledgeRuntimeRevision" + 1
      WHERE "id" = OLD."businessId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE source_table TEXT;
BEGIN
  FOREACH source_table IN ARRAY ARRAY[
    'Service', 'BusinessAvailability', 'BusinessPolicy', 'KnowledgeArticle',
    'KnowledgeDocument', 'KnowledgeDocumentVersion', 'KnowledgeDocumentFact',
    'KnowledgeDocumentChunk', 'KnowledgeGovernanceReview'
  ] LOOP
    EXECUTE format('CREATE TRIGGER knowledge_runtime_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "bumpKnowledgeRuntimeRevision"()', source_table);
  END LOOP;
END;
$$;

CREATE FUNCTION "bumpProfileKnowledgeRuntimeRevision"() RETURNS trigger AS $$
BEGIN
  NEW."knowledgeRuntimeRevision" := OLD."knowledgeRuntimeRevision" + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profile_knowledge_runtime_revision
BEFORE UPDATE OF "name", "industry", "description", "country", "city", "address",
  "serviceArea", "phone", "email", "website", "timezone", "defaultCurrency",
  "appointmentConfirmationMode", "aiTone", "deletedAt"
ON "Business" FOR EACH ROW EXECUTE FUNCTION "bumpProfileKnowledgeRuntimeRevision"();
