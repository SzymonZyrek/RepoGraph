export interface Order { id: string }
export const validate = (order: Order): boolean => order.id.length > 0;
