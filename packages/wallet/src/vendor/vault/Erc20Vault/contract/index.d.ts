import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  initialise(context: __compactRuntime.CircuitContext<PS>,
             vaultEvm_0: Uint8Array,
             chainId_0: bigint,
             responseKey_0: __compactRuntime.Secp256k1Point,
             deployerSignature_0: { r: bigint, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  startDeposit(context: __compactRuntime.CircuitContext<PS>,
               evmNonce_0: bigint,
               gasLimit_0: bigint,
               maxFeePerGas_0: bigint,
               maxPriorityFeePerGas_0: bigint,
               keyVersion_0: bigint,
               erc20Address_0: Uint8Array,
               amount_0: bigint,
               recipient_0: { is_left: boolean,
                              left: { bytes: Uint8Array },
                              right: { bytes: Uint8Array }
                            }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  completeDeposit(context: __compactRuntime.CircuitContext<PS>,
                  requestId_0: Uint8Array,
                  respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                      y: Uint8Array
                                                                    },
                                                              s: Uint8Array,
                                                              recoveryId: bigint
                                                            }
                                               },
                  serializedOutput_0: Uint8Array,
                  mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                          value: { nonce: Uint8Array,
                                                                                                   color: Uint8Array,
                                                                                                   value: bigint
                                                                                                 }
                                                                                        }>>;
  abandonDeposit(context: __compactRuntime.CircuitContext<PS>,
                 requestId_0: Uint8Array,
                 respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                     y: Uint8Array
                                                                   },
                                                             s: Uint8Array,
                                                             recoveryId: bigint
                                                           }
                                              },
                 serializedOutput_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  startWithdraw(context: __compactRuntime.CircuitContext<PS>,
                evmNonce_0: bigint,
                gasLimit_0: bigint,
                maxFeePerGas_0: bigint,
                maxPriorityFeePerGas_0: bigint,
                keyVersion_0: bigint,
                erc20Address_0: Uint8Array,
                amount_0: bigint,
                destEvmAddress_0: Uint8Array,
                coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint },
                refundRecipient_0: { is_left: boolean,
                                     left: { bytes: Uint8Array },
                                     right: { bytes: Uint8Array }
                                   }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  completeWithdraw(context: __compactRuntime.CircuitContext<PS>,
                   requestId_0: Uint8Array,
                   respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                       y: Uint8Array
                                                                     },
                                                               s: Uint8Array,
                                                               recoveryId: bigint
                                                             }
                                                },
                   serializedOutput_0: Uint8Array,
                   mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                           value: { nonce: Uint8Array,
                                                                                                    color: Uint8Array,
                                                                                                    value: bigint
                                                                                                  }
                                                                                         }>>;
  refundWithdraw(context: __compactRuntime.CircuitContext<PS>,
                 requestId_0: Uint8Array,
                 respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                     y: Uint8Array
                                                                   },
                                                             s: Uint8Array,
                                                             recoveryId: bigint
                                                           }
                                              },
                 serializedOutput_0: Uint8Array,
                 mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                                         color: Uint8Array,
                                                                                         value: bigint
                                                                                       }>>;
  publishTokenMetadata(context: __compactRuntime.CircuitContext<PS>,
                       erc20Address_0: Uint8Array,
                       name_0: Uint8Array,
                       nameLen_0: bigint,
                       symbol_0: Uint8Array,
                       symbolLen_0: bigint,
                       decimals_0: bigint,
                       validUntil_0: bigint,
                       adminSignature_0: { r: bigint, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  initialise(context: __compactRuntime.CircuitContext<PS>,
             vaultEvm_0: Uint8Array,
             chainId_0: bigint,
             responseKey_0: __compactRuntime.Secp256k1Point,
             deployerSignature_0: { r: bigint, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  startDeposit(context: __compactRuntime.CircuitContext<PS>,
               evmNonce_0: bigint,
               gasLimit_0: bigint,
               maxFeePerGas_0: bigint,
               maxPriorityFeePerGas_0: bigint,
               keyVersion_0: bigint,
               erc20Address_0: Uint8Array,
               amount_0: bigint,
               recipient_0: { is_left: boolean,
                              left: { bytes: Uint8Array },
                              right: { bytes: Uint8Array }
                            }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  completeDeposit(context: __compactRuntime.CircuitContext<PS>,
                  requestId_0: Uint8Array,
                  respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                      y: Uint8Array
                                                                    },
                                                              s: Uint8Array,
                                                              recoveryId: bigint
                                                            }
                                               },
                  serializedOutput_0: Uint8Array,
                  mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                          value: { nonce: Uint8Array,
                                                                                                   color: Uint8Array,
                                                                                                   value: bigint
                                                                                                 }
                                                                                        }>>;
  abandonDeposit(context: __compactRuntime.CircuitContext<PS>,
                 requestId_0: Uint8Array,
                 respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                     y: Uint8Array
                                                                   },
                                                             s: Uint8Array,
                                                             recoveryId: bigint
                                                           }
                                              },
                 serializedOutput_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  startWithdraw(context: __compactRuntime.CircuitContext<PS>,
                evmNonce_0: bigint,
                gasLimit_0: bigint,
                maxFeePerGas_0: bigint,
                maxPriorityFeePerGas_0: bigint,
                keyVersion_0: bigint,
                erc20Address_0: Uint8Array,
                amount_0: bigint,
                destEvmAddress_0: Uint8Array,
                coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint },
                refundRecipient_0: { is_left: boolean,
                                     left: { bytes: Uint8Array },
                                     right: { bytes: Uint8Array }
                                   }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  completeWithdraw(context: __compactRuntime.CircuitContext<PS>,
                   requestId_0: Uint8Array,
                   respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                       y: Uint8Array
                                                                     },
                                                               s: Uint8Array,
                                                               recoveryId: bigint
                                                             }
                                                },
                   serializedOutput_0: Uint8Array,
                   mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                           value: { nonce: Uint8Array,
                                                                                                    color: Uint8Array,
                                                                                                    value: bigint
                                                                                                  }
                                                                                         }>>;
  refundWithdraw(context: __compactRuntime.CircuitContext<PS>,
                 requestId_0: Uint8Array,
                 respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                     y: Uint8Array
                                                                   },
                                                             s: Uint8Array,
                                                             recoveryId: bigint
                                                           }
                                              },
                 serializedOutput_0: Uint8Array,
                 mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                                         color: Uint8Array,
                                                                                         value: bigint
                                                                                       }>>;
  publishTokenMetadata(context: __compactRuntime.CircuitContext<PS>,
                       erc20Address_0: Uint8Array,
                       name_0: Uint8Array,
                       nameLen_0: bigint,
                       symbol_0: Uint8Array,
                       symbolLen_0: bigint,
                       decimals_0: bigint,
                       validUntil_0: bigint,
                       adminSignature_0: { r: bigint, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
  vaultResponseSchema(): Uint8Array;
  vaultTokenDomainSeparator(erc20Address_0: Uint8Array): Uint8Array;
  depositPath(recipient_0: { is_left: boolean,
                             left: { bytes: Uint8Array },
                             right: { bytes: Uint8Array }
                           }): Uint8Array;
  vaultPath(): Uint8Array;
  initialiseDigest(vaultAddress_0: { bytes: Uint8Array },
                   vaultEvm_0: Uint8Array,
                   chainId_0: bigint,
                   responseKey_0: __compactRuntime.Secp256k1Point): Uint8Array;
  tokenMetadataDigest(vaultAddress_0: { bytes: Uint8Array },
                      erc20Address_0: Uint8Array,
                      name_0: Uint8Array,
                      nameLen_0: bigint,
                      symbol_0: Uint8Array,
                      symbolLen_0: bigint,
                      decimals_0: bigint,
                      validUntil_0: bigint): Uint8Array;
}

export type Circuits<PS> = {
  vaultResponseSchema(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  vaultTokenDomainSeparator(context: __compactRuntime.CircuitContext<PS>,
                            erc20Address_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  depositPath(context: __compactRuntime.CircuitContext<PS>,
              recipient_0: { is_left: boolean,
                             left: { bytes: Uint8Array },
                             right: { bytes: Uint8Array }
                           }): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  vaultPath(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  initialiseDigest(context: __compactRuntime.CircuitContext<PS>,
                   vaultAddress_0: { bytes: Uint8Array },
                   vaultEvm_0: Uint8Array,
                   chainId_0: bigint,
                   responseKey_0: __compactRuntime.Secp256k1Point): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  initialise(context: __compactRuntime.CircuitContext<PS>,
             vaultEvm_0: Uint8Array,
             chainId_0: bigint,
             responseKey_0: __compactRuntime.Secp256k1Point,
             deployerSignature_0: { r: bigint, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  startDeposit(context: __compactRuntime.CircuitContext<PS>,
               evmNonce_0: bigint,
               gasLimit_0: bigint,
               maxFeePerGas_0: bigint,
               maxPriorityFeePerGas_0: bigint,
               keyVersion_0: bigint,
               erc20Address_0: Uint8Array,
               amount_0: bigint,
               recipient_0: { is_left: boolean,
                              left: { bytes: Uint8Array },
                              right: { bytes: Uint8Array }
                            }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  completeDeposit(context: __compactRuntime.CircuitContext<PS>,
                  requestId_0: Uint8Array,
                  respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                      y: Uint8Array
                                                                    },
                                                              s: Uint8Array,
                                                              recoveryId: bigint
                                                            }
                                               },
                  serializedOutput_0: Uint8Array,
                  mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                          value: { nonce: Uint8Array,
                                                                                                   color: Uint8Array,
                                                                                                   value: bigint
                                                                                                 }
                                                                                        }>>;
  abandonDeposit(context: __compactRuntime.CircuitContext<PS>,
                 requestId_0: Uint8Array,
                 respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                     y: Uint8Array
                                                                   },
                                                             s: Uint8Array,
                                                             recoveryId: bigint
                                                           }
                                              },
                 serializedOutput_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  startWithdraw(context: __compactRuntime.CircuitContext<PS>,
                evmNonce_0: bigint,
                gasLimit_0: bigint,
                maxFeePerGas_0: bigint,
                maxPriorityFeePerGas_0: bigint,
                keyVersion_0: bigint,
                erc20Address_0: Uint8Array,
                amount_0: bigint,
                destEvmAddress_0: Uint8Array,
                coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint },
                refundRecipient_0: { is_left: boolean,
                                     left: { bytes: Uint8Array },
                                     right: { bytes: Uint8Array }
                                   }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  completeWithdraw(context: __compactRuntime.CircuitContext<PS>,
                   requestId_0: Uint8Array,
                   respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                       y: Uint8Array
                                                                     },
                                                               s: Uint8Array,
                                                               recoveryId: bigint
                                                             }
                                                },
                   serializedOutput_0: Uint8Array,
                   mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { is_some: boolean,
                                                                                           value: { nonce: Uint8Array,
                                                                                                    color: Uint8Array,
                                                                                                    value: bigint
                                                                                                  }
                                                                                         }>>;
  refundWithdraw(context: __compactRuntime.CircuitContext<PS>,
                 requestId_0: Uint8Array,
                 respondBidirectionalEvent_0: { signature: { bigR: { x: Uint8Array,
                                                                     y: Uint8Array
                                                                   },
                                                             s: Uint8Array,
                                                             recoveryId: bigint
                                                           }
                                              },
                 serializedOutput_0: Uint8Array,
                 mintNonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                                         color: Uint8Array,
                                                                                         value: bigint
                                                                                       }>>;
  tokenMetadataDigest(context: __compactRuntime.CircuitContext<PS>,
                      vaultAddress_0: { bytes: Uint8Array },
                      erc20Address_0: Uint8Array,
                      name_0: Uint8Array,
                      nameLen_0: bigint,
                      symbol_0: Uint8Array,
                      symbolLen_0: bigint,
                      decimals_0: bigint,
                      validUntil_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  publishTokenMetadata(context: __compactRuntime.CircuitContext<PS>,
                       erc20Address_0: Uint8Array,
                       name_0: Uint8Array,
                       nameLen_0: bigint,
                       symbol_0: Uint8Array,
                       symbolLen_0: bigint,
                       decimals_0: bigint,
                       validUntil_0: bigint,
                       adminSignature_0: { r: bigint, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type Ledger = {
  depositEventMap: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { sender: { bytes: Uint8Array },
                                 requestNonce: bigint,
                                 keyVersion: bigint,
                                 path: Uint8Array,
                                 algo: number,
                                 dest: number,
                                 params: Uint8Array,
                                 txParamType: number,
                                 txParams: { chainId: bigint,
                                             nonce: bigint,
                                             maxPriorityFeePerGas: bigint,
                                             maxFeePerGas: bigint,
                                             gasLimit: bigint,
                                             to: Uint8Array,
                                             value: bigint,
                                             calldata: { is_some: boolean,
                                                         value: { selector: Uint8Array,
                                                                  noWords: bigint,
                                                                  words: Uint8Array[]
                                                                }
                                                       },
                                             accessListEntryCount: bigint,
                                             accessList: { address: Uint8Array,
                                                           storageKeyCount: bigint,
                                                           storageKeys: Uint8Array[]
                                                         }[]
                                           },
                                 caip2Id: Uint8Array,
                                 outputDeserializationSchema: Uint8Array,
                                 respondSerializationSchema: Uint8Array
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { sender: { bytes: Uint8Array },
  requestNonce: bigint,
  keyVersion: bigint,
  path: Uint8Array,
  algo: number,
  dest: number,
  params: Uint8Array,
  txParamType: number,
  txParams: { chainId: bigint,
              nonce: bigint,
              maxPriorityFeePerGas: bigint,
              maxFeePerGas: bigint,
              gasLimit: bigint,
              to: Uint8Array,
              value: bigint,
              calldata: { is_some: boolean,
                          value: { selector: Uint8Array,
                                   noWords: bigint,
                                   words: Uint8Array[]
                                 }
                        },
              accessListEntryCount: bigint,
              accessList: { address: Uint8Array,
                            storageKeyCount: bigint,
                            storageKeys: Uint8Array[]
                          }[]
            },
  caip2Id: Uint8Array,
  outputDeserializationSchema: Uint8Array,
  respondSerializationSchema: Uint8Array
}]>
  };
  depositSettleViews: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { recipient: { is_left: boolean,
                                              left: { bytes: Uint8Array },
                                              right: { bytes: Uint8Array }
                                            },
                                 erc20: Uint8Array,
                                 amount: bigint
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { recipient: { is_left: boolean,
               left: { bytes: Uint8Array },
               right: { bytes: Uint8Array }
             },
  erc20: Uint8Array,
  amount: bigint
}]>
  };
  withdrawEventMap: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { sender: { bytes: Uint8Array },
                                 requestNonce: bigint,
                                 keyVersion: bigint,
                                 path: Uint8Array,
                                 algo: number,
                                 dest: number,
                                 params: Uint8Array,
                                 txParamType: number,
                                 txParams: { chainId: bigint,
                                             nonce: bigint,
                                             maxPriorityFeePerGas: bigint,
                                             maxFeePerGas: bigint,
                                             gasLimit: bigint,
                                             to: Uint8Array,
                                             value: bigint,
                                             calldata: { is_some: boolean,
                                                         value: { selector: Uint8Array,
                                                                  noWords: bigint,
                                                                  words: Uint8Array[]
                                                                }
                                                       },
                                             accessListEntryCount: bigint,
                                             accessList: { address: Uint8Array,
                                                           storageKeyCount: bigint,
                                                           storageKeys: Uint8Array[]
                                                         }[]
                                           },
                                 caip2Id: Uint8Array,
                                 outputDeserializationSchema: Uint8Array,
                                 respondSerializationSchema: Uint8Array
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { sender: { bytes: Uint8Array },
  requestNonce: bigint,
  keyVersion: bigint,
  path: Uint8Array,
  algo: number,
  dest: number,
  params: Uint8Array,
  txParamType: number,
  txParams: { chainId: bigint,
              nonce: bigint,
              maxPriorityFeePerGas: bigint,
              maxFeePerGas: bigint,
              gasLimit: bigint,
              to: Uint8Array,
              value: bigint,
              calldata: { is_some: boolean,
                          value: { selector: Uint8Array,
                                   noWords: bigint,
                                   words: Uint8Array[]
                                 }
                        },
              accessListEntryCount: bigint,
              accessList: { address: Uint8Array,
                            storageKeyCount: bigint,
                            storageKeys: Uint8Array[]
                          }[]
            },
  caip2Id: Uint8Array,
  outputDeserializationSchema: Uint8Array,
  respondSerializationSchema: Uint8Array
}]>
  };
  withdrawSettleViews: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { refundRecipient: { is_left: boolean,
                                                    left: { bytes: Uint8Array },
                                                    right: { bytes: Uint8Array }
                                                  },
                                 erc20: Uint8Array,
                                 amount: bigint
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { refundRecipient: { is_left: boolean,
                     left: { bytes: Uint8Array },
                     right: { bytes: Uint8Array }
                   },
  erc20: Uint8Array,
  amount: bigint
}]>
  };
  readonly mpcResponseKey: __compactRuntime.Secp256k1Point;
  readonly signetRequestNonce: bigint;
  readonly initialised: bigint;
  readonly vaultEvmAddress: Uint8Array;
  readonly evmChainId: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               deployerPublicKey_0: __compactRuntime.Secp256k1Point,
               signetContract_0: { bytes: Uint8Array }): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
