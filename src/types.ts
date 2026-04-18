import "express-session";

declare module "express-session" {
  interface SessionData {
    user: {
      id: string;
      telegramId: string;
      firstName: string | null;
      username: string | null;
    };
  }
}