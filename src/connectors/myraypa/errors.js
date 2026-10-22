export class MyraypaError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'MyraypaError';
    this.status = status;
  }
}
