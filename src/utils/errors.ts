export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = "REQUEST_FAILED",
    public context?: Record<string, unknown>,
  ) {
    super(message);
  }
}
