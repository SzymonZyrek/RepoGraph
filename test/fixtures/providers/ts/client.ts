import { validate } from "./model";
export const submit = (id: string): boolean => validate({ id });
