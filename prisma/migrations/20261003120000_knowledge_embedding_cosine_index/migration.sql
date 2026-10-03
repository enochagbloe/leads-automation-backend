-- Match existing cosine-distance (<=>) search and vector(1536).
CREATE INDEX "KnowledgeSearchEmbedding_embedding_cosine_idx"
ON "KnowledgeSearchEmbedding" USING hnsw ("embedding" vector_cosine_ops);
