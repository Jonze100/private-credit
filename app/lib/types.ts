export interface PositionState {
  collateralAmount: number;
  collateralPrice: number;
  borrowAmount: number;
  interestAccrued: number;
  healthFactor: number | null;
  isLiquidatable: boolean | null;
}

export type TxEventType =
  | 'deposit'
  | 'borrow'
  | 'health'
  | 'interest'
  | 'liquidation';

export interface TxEvent {
  id: string;
  type: TxEventType;
  label: string;
  detail: string;
  signature?: string;
  timestamp: number;
  ok: boolean;
}
