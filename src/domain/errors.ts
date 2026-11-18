export class CommerceError extends Error {
  constructor(
    public status: number,
    public code: string,
    public title: string,
    public detail: string,
    public extra?: Record<string, unknown>,
  ) {
    super(detail);
  }
}
