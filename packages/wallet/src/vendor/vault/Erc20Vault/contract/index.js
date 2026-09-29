import * as __compactRuntime from '@midnight-ntwrk/compact-runtime';
import * as __compactContractsImport_SignetSigner from '../../SignetSigner/contract/index.js';
__compactRuntime.checkRuntimeVersion('0.19.0');

const _descriptor_0 = __compactRuntime.CompactTypeSecp256k1Point;

const _descriptor_1 = new __compactRuntime.CompactTypeBytes(32);

class _ContractAddress_0 {
  alignment() {
    return _descriptor_1.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0.bytes);
  }
}

const _descriptor_2 = new _ContractAddress_0();

const _descriptor_3 = new __compactRuntime.CompactTypeBytes(20);

const _descriptor_4 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);

const _descriptor_5 = new __compactRuntime.CompactTypeUnsignedInteger(18446744073709551615n, 8);

const _descriptor_6 = __compactRuntime.CompactTypeSecp256k1Scalar;

class _Secp256k1EcdsaSignature_0 {
  alignment() {
    return _descriptor_6.alignment().concat(_descriptor_6.alignment());
  }
  fromValue(value_0) {
    return {
      r: _descriptor_6.fromValue(value_0),
      s: _descriptor_6.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_6.toValue(value_0.r).concat(_descriptor_6.toValue(value_0.s));
  }
}

const _descriptor_7 = new _Secp256k1EcdsaSignature_0();

const _descriptor_8 = __compactRuntime.CompactTypeBoolean;

class _ZswapCoinPublicKey_0 {
  alignment() {
    return _descriptor_1.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0.bytes);
  }
}

const _descriptor_9 = new _ZswapCoinPublicKey_0();

class _Either_0 {
  alignment() {
    return _descriptor_8.alignment().concat(_descriptor_9.alignment().concat(_descriptor_2.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_8.fromValue(value_0),
      left: _descriptor_9.fromValue(value_0),
      right: _descriptor_2.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_8.toValue(value_0.is_left).concat(_descriptor_9.toValue(value_0.left).concat(_descriptor_2.toValue(value_0.right)));
  }
}

const _descriptor_10 = new _Either_0();

class _WithdrawSettleView_0 {
  alignment() {
    return _descriptor_10.alignment().concat(_descriptor_3.alignment().concat(_descriptor_5.alignment()));
  }
  fromValue(value_0) {
    return {
      refundRecipient: _descriptor_10.fromValue(value_0),
      erc20: _descriptor_3.fromValue(value_0),
      amount: _descriptor_5.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_10.toValue(value_0.refundRecipient).concat(_descriptor_3.toValue(value_0.erc20).concat(_descriptor_5.toValue(value_0.amount)));
  }
}

const _descriptor_11 = new _WithdrawSettleView_0();

const _descriptor_12 = new __compactRuntime.CompactTypeEnum(1, 1);

const _descriptor_13 = new __compactRuntime.CompactTypeEnum(1, 1);

const _descriptor_14 = new __compactRuntime.CompactTypeBytes(64);

const _descriptor_15 = new __compactRuntime.CompactTypeEnum(1, 1);

const _descriptor_16 = new __compactRuntime.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);

const _descriptor_17 = new __compactRuntime.CompactTypeBytes(4);

const _descriptor_18 = new __compactRuntime.CompactTypeUnsignedInteger(65535n, 2);

const _descriptor_19 = new __compactRuntime.CompactTypeVector(2, _descriptor_1);

class _EvmCalldata_0 {
  alignment() {
    return _descriptor_17.alignment().concat(_descriptor_18.alignment().concat(_descriptor_19.alignment()));
  }
  fromValue(value_0) {
    return {
      selector: _descriptor_17.fromValue(value_0),
      noWords: _descriptor_18.fromValue(value_0),
      words: _descriptor_19.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_17.toValue(value_0.selector).concat(_descriptor_18.toValue(value_0.noWords).concat(_descriptor_19.toValue(value_0.words)));
  }
}

const _descriptor_20 = new _EvmCalldata_0();

class _Maybe_0 {
  alignment() {
    return _descriptor_8.alignment().concat(_descriptor_20.alignment());
  }
  fromValue(value_0) {
    return {
      is_some: _descriptor_8.fromValue(value_0),
      value: _descriptor_20.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_8.toValue(value_0.is_some).concat(_descriptor_20.toValue(value_0.value));
  }
}

const _descriptor_21 = new _Maybe_0();

const _descriptor_22 = new __compactRuntime.CompactTypeVector(0, _descriptor_1);

class _EvmAccessListEntry_0 {
  alignment() {
    return _descriptor_3.alignment().concat(_descriptor_4.alignment().concat(_descriptor_22.alignment()));
  }
  fromValue(value_0) {
    return {
      address: _descriptor_3.fromValue(value_0),
      storageKeyCount: _descriptor_4.fromValue(value_0),
      storageKeys: _descriptor_22.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_3.toValue(value_0.address).concat(_descriptor_4.toValue(value_0.storageKeyCount).concat(_descriptor_22.toValue(value_0.storageKeys)));
  }
}

const _descriptor_23 = new _EvmAccessListEntry_0();

const _descriptor_24 = new __compactRuntime.CompactTypeVector(0, _descriptor_23);

class _EvmType2TxParams_0 {
  alignment() {
    return _descriptor_5.alignment().concat(_descriptor_5.alignment().concat(_descriptor_16.alignment().concat(_descriptor_16.alignment().concat(_descriptor_5.alignment().concat(_descriptor_3.alignment().concat(_descriptor_16.alignment().concat(_descriptor_21.alignment().concat(_descriptor_4.alignment().concat(_descriptor_24.alignment())))))))));
  }
  fromValue(value_0) {
    return {
      chainId: _descriptor_5.fromValue(value_0),
      nonce: _descriptor_5.fromValue(value_0),
      maxPriorityFeePerGas: _descriptor_16.fromValue(value_0),
      maxFeePerGas: _descriptor_16.fromValue(value_0),
      gasLimit: _descriptor_5.fromValue(value_0),
      to: _descriptor_3.fromValue(value_0),
      value: _descriptor_16.fromValue(value_0),
      calldata: _descriptor_21.fromValue(value_0),
      accessListEntryCount: _descriptor_4.fromValue(value_0),
      accessList: _descriptor_24.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_5.toValue(value_0.chainId).concat(_descriptor_5.toValue(value_0.nonce).concat(_descriptor_16.toValue(value_0.maxPriorityFeePerGas).concat(_descriptor_16.toValue(value_0.maxFeePerGas).concat(_descriptor_5.toValue(value_0.gasLimit).concat(_descriptor_3.toValue(value_0.to).concat(_descriptor_16.toValue(value_0.value).concat(_descriptor_21.toValue(value_0.calldata).concat(_descriptor_4.toValue(value_0.accessListEntryCount).concat(_descriptor_24.toValue(value_0.accessList))))))))));
  }
}

const _descriptor_25 = new _EvmType2TxParams_0();

const _descriptor_26 = new __compactRuntime.CompactTypeBytes(34);

class _SignBidirectionalEvent_0 {
  alignment() {
    return _descriptor_2.alignment().concat(_descriptor_5.alignment().concat(_descriptor_4.alignment().concat(_descriptor_1.alignment().concat(_descriptor_12.alignment().concat(_descriptor_13.alignment().concat(_descriptor_14.alignment().concat(_descriptor_15.alignment().concat(_descriptor_25.alignment().concat(_descriptor_1.alignment().concat(_descriptor_26.alignment().concat(_descriptor_26.alignment())))))))))));
  }
  fromValue(value_0) {
    return {
      sender: _descriptor_2.fromValue(value_0),
      requestNonce: _descriptor_5.fromValue(value_0),
      keyVersion: _descriptor_4.fromValue(value_0),
      path: _descriptor_1.fromValue(value_0),
      algo: _descriptor_12.fromValue(value_0),
      dest: _descriptor_13.fromValue(value_0),
      params: _descriptor_14.fromValue(value_0),
      txParamType: _descriptor_15.fromValue(value_0),
      txParams: _descriptor_25.fromValue(value_0),
      caip2Id: _descriptor_1.fromValue(value_0),
      outputDeserializationSchema: _descriptor_26.fromValue(value_0),
      respondSerializationSchema: _descriptor_26.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_2.toValue(value_0.sender).concat(_descriptor_5.toValue(value_0.requestNonce).concat(_descriptor_4.toValue(value_0.keyVersion).concat(_descriptor_1.toValue(value_0.path).concat(_descriptor_12.toValue(value_0.algo).concat(_descriptor_13.toValue(value_0.dest).concat(_descriptor_14.toValue(value_0.params).concat(_descriptor_15.toValue(value_0.txParamType).concat(_descriptor_25.toValue(value_0.txParams).concat(_descriptor_1.toValue(value_0.caip2Id).concat(_descriptor_26.toValue(value_0.outputDeserializationSchema).concat(_descriptor_26.toValue(value_0.respondSerializationSchema))))))))))));
  }
}

const _descriptor_27 = new _SignBidirectionalEvent_0();

class _AffinePoint_0 {
  alignment() {
    return _descriptor_1.alignment().concat(_descriptor_1.alignment());
  }
  fromValue(value_0) {
    return {
      x: _descriptor_1.fromValue(value_0),
      y: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0.x).concat(_descriptor_1.toValue(value_0.y));
  }
}

const _descriptor_28 = new _AffinePoint_0();

class _Signature_0 {
  alignment() {
    return _descriptor_28.alignment().concat(_descriptor_1.alignment().concat(_descriptor_4.alignment()));
  }
  fromValue(value_0) {
    return {
      bigR: _descriptor_28.fromValue(value_0),
      s: _descriptor_1.fromValue(value_0),
      recoveryId: _descriptor_4.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_28.toValue(value_0.bigR).concat(_descriptor_1.toValue(value_0.s).concat(_descriptor_4.toValue(value_0.recoveryId)));
  }
}

const _descriptor_29 = new _Signature_0();

class _RespondBidirectionalEvent_0 {
  alignment() {
    return _descriptor_29.alignment();
  }
  fromValue(value_0) {
    return {
      signature: _descriptor_29.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_29.toValue(value_0.signature);
  }
}

const _descriptor_30 = new _RespondBidirectionalEvent_0();

const _descriptor_31 = new __compactRuntime.CompactTypeBytes(5);

class _ShieldedCoinInfo_0 {
  alignment() {
    return _descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_16.alignment()));
  }
  fromValue(value_0) {
    return {
      nonce: _descriptor_1.fromValue(value_0),
      color: _descriptor_1.fromValue(value_0),
      value: _descriptor_16.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0.nonce).concat(_descriptor_1.toValue(value_0.color).concat(_descriptor_16.toValue(value_0.value)));
  }
}

const _descriptor_32 = new _ShieldedCoinInfo_0();

const _descriptor_33 = new __compactRuntime.CompactTypeBytes(1);

class _Maybe_1 {
  alignment() {
    return _descriptor_8.alignment().concat(_descriptor_32.alignment());
  }
  fromValue(value_0) {
    return {
      is_some: _descriptor_8.fromValue(value_0),
      value: _descriptor_32.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_8.toValue(value_0.is_some).concat(_descriptor_32.toValue(value_0.value));
  }
}

const _descriptor_34 = new _Maybe_1();

class _DepositSettleView_0 {
  alignment() {
    return _descriptor_10.alignment().concat(_descriptor_3.alignment().concat(_descriptor_5.alignment()));
  }
  fromValue(value_0) {
    return {
      recipient: _descriptor_10.fromValue(value_0),
      erc20: _descriptor_3.fromValue(value_0),
      amount: _descriptor_5.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_10.toValue(value_0.recipient).concat(_descriptor_3.toValue(value_0.erc20).concat(_descriptor_5.toValue(value_0.amount)));
  }
}

const _descriptor_35 = new _DepositSettleView_0();

const _descriptor_36 = new __compactRuntime.CompactTypeBytes(288);

const _descriptor_37 = new __compactRuntime.CompactTypeBytes(189);

const _descriptor_38 = new __compactRuntime.CompactTypeVector(4, _descriptor_4);

const _descriptor_39 = new __compactRuntime.CompactTypeBytes(128);

class _SignBidirectionalEventNotification_0 {
  alignment() {
    return _descriptor_4.alignment().concat(_descriptor_39.alignment());
  }
  fromValue(value_0) {
    return {
      version: _descriptor_4.fromValue(value_0),
      payload: _descriptor_39.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_4.toValue(value_0.version).concat(_descriptor_39.toValue(value_0.payload));
  }
}

const _descriptor_40 = new _SignBidirectionalEventNotification_0();

class _VaultResponse_0 {
  alignment() {
    return _descriptor_8.alignment();
  }
  fromValue(value_0) {
    return {
      success: _descriptor_8.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_8.toValue(value_0.success);
  }
}

const _descriptor_41 = new _VaultResponse_0();

const _descriptor_42 = __compactRuntime.CompactTypeSecp256k1Base;

const _descriptor_43 = __compactRuntime.CompactTypeField;

class _tuple_0 {
  alignment() {
    return _descriptor_1.alignment().concat(_descriptor_2.alignment().concat(_descriptor_3.alignment().concat(_descriptor_1.alignment().concat(_descriptor_4.alignment().concat(_descriptor_1.alignment().concat(_descriptor_4.alignment().concat(_descriptor_4.alignment().concat(_descriptor_5.alignment()))))))));
  }
  fromValue(value_0) {
    return [
      _descriptor_1.fromValue(value_0),
      _descriptor_2.fromValue(value_0),
      _descriptor_3.fromValue(value_0),
      _descriptor_1.fromValue(value_0),
      _descriptor_4.fromValue(value_0),
      _descriptor_1.fromValue(value_0),
      _descriptor_4.fromValue(value_0),
      _descriptor_4.fromValue(value_0),
      _descriptor_5.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0[0]).concat(_descriptor_2.toValue(value_0[1]).concat(_descriptor_3.toValue(value_0[2]).concat(_descriptor_1.toValue(value_0[3]).concat(_descriptor_4.toValue(value_0[4]).concat(_descriptor_1.toValue(value_0[5]).concat(_descriptor_4.toValue(value_0[6]).concat(_descriptor_4.toValue(value_0[7]).concat(_descriptor_5.toValue(value_0[8])))))))));
  }
}

const _descriptor_44 = new _tuple_0();

class _tuple_1 {
  alignment() {
    return _descriptor_1.alignment().concat(_descriptor_2.alignment().concat(_descriptor_3.alignment().concat(_descriptor_5.alignment().concat(_descriptor_0.alignment()))));
  }
  fromValue(value_0) {
    return [
      _descriptor_1.fromValue(value_0),
      _descriptor_2.fromValue(value_0),
      _descriptor_3.fromValue(value_0),
      _descriptor_5.fromValue(value_0),
      _descriptor_0.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0[0]).concat(_descriptor_2.toValue(value_0[1]).concat(_descriptor_3.toValue(value_0[2]).concat(_descriptor_5.toValue(value_0[3]).concat(_descriptor_0.toValue(value_0[4])))));
  }
}

const _descriptor_45 = new _tuple_1();

const _descriptor_46 = new __compactRuntime.CompactTypeBytes(21);

class _CoinPreimage_0 {
  alignment() {
    return _descriptor_46.alignment().concat(_descriptor_32.alignment().concat(_descriptor_8.alignment().concat(_descriptor_1.alignment())));
  }
  fromValue(value_0) {
    return {
      domain_sep: _descriptor_46.fromValue(value_0),
      info: _descriptor_32.fromValue(value_0),
      dataType: _descriptor_8.fromValue(value_0),
      data: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_46.toValue(value_0.domain_sep).concat(_descriptor_32.toValue(value_0.info).concat(_descriptor_8.toValue(value_0.dataType).concat(_descriptor_1.toValue(value_0.data))));
  }
}

const _descriptor_47 = new _CoinPreimage_0();

class _tuple_2 {
  alignment() {
    return _descriptor_1.alignment().concat(_descriptor_5.alignment().concat(_descriptor_31.alignment()));
  }
  fromValue(value_0) {
    return [
      _descriptor_1.fromValue(value_0),
      _descriptor_5.fromValue(value_0),
      _descriptor_31.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0[0]).concat(_descriptor_5.toValue(value_0[1]).concat(_descriptor_31.toValue(value_0[2])));
  }
}

const _descriptor_48 = new _tuple_2();

class _tuple_3 {
  alignment() {
    return _descriptor_1.alignment().concat(_descriptor_8.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment())));
  }
  fromValue(value_0) {
    return [
      _descriptor_1.fromValue(value_0),
      _descriptor_8.fromValue(value_0),
      _descriptor_1.fromValue(value_0),
      _descriptor_1.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0[0]).concat(_descriptor_8.toValue(value_0[1]).concat(_descriptor_1.toValue(value_0[2]).concat(_descriptor_1.toValue(value_0[3]))));
  }
}

const _descriptor_49 = new _tuple_3();

class _tuple_4 {
  alignment() {
    return _descriptor_1.alignment().concat(_descriptor_5.alignment().concat(_descriptor_33.alignment()));
  }
  fromValue(value_0) {
    return [
      _descriptor_1.fromValue(value_0),
      _descriptor_5.fromValue(value_0),
      _descriptor_33.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0[0]).concat(_descriptor_5.toValue(value_0[1]).concat(_descriptor_33.toValue(value_0[2])));
  }
}

const _descriptor_50 = new _tuple_4();

class _Either_1 {
  alignment() {
    return _descriptor_8.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_8.fromValue(value_0),
      left: _descriptor_1.fromValue(value_0),
      right: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_8.toValue(value_0.is_left).concat(_descriptor_1.toValue(value_0.left).concat(_descriptor_1.toValue(value_0.right)));
  }
}

const _descriptor_51 = new _Either_1();

const _descriptor_52 = new __compactRuntime.CompactTypeUnsignedInteger(4294967295n, 4);

export class Contract {
  witnesses;
  constructor(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`Contract constructor: expected 1 argument, received ${args_0.length}`);
    }
    const witnesses_0 = args_0[0];
    if (typeof(witnesses_0) !== 'object') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor is not an object');
    }
    this.witnesses = witnesses_0;
    this.circuits = {
      async vaultResponseSchema(context, ...args_1) {
        return { result: pureCircuits.vaultResponseSchema(...args_1), context };
      },
      async vaultTokenDomainSeparator(context, ...args_1) {
        return { result: pureCircuits.vaultTokenDomainSeparator(...args_1), context };
      },
      async depositPath(context, ...args_1) {
        return { result: pureCircuits.depositPath(...args_1), context };
      },
      async vaultPath(context, ...args_1) {
        return { result: pureCircuits.vaultPath(...args_1), context };
      },
      async initialiseDigest(context, ...args_1) {
        return { result: pureCircuits.initialiseDigest(...args_1), context };
      },
      initialise: async (...args_1) => {
        if (args_1.length !== 5) {
          throw new __compactRuntime.CompactError(`initialise: expected 5 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const vaultEvm_0 = args_1[1];
        const chainId_0 = args_1[2];
        const responseKey_0 = args_1[3];
        const deployerSignature_0 = args_1[4];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('initialise',
                                     'argument 1 (as invoked from Typescript)',
                                     'erc20-vault.compact line 261 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(vaultEvm_0.buffer instanceof ArrayBuffer && vaultEvm_0.BYTES_PER_ELEMENT === 1 && vaultEvm_0.length === 20)) {
          __compactRuntime.typeError('initialise',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'erc20-vault.compact line 261 char 1',
                                     'Bytes<20>',
                                     vaultEvm_0)
        }
        if (!(typeof(chainId_0) === 'bigint' && chainId_0 >= 0n && chainId_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('initialise',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'erc20-vault.compact line 261 char 1',
                                     'Uint<0..18446744073709551616>',
                                     chainId_0)
        }
        if (!(typeof(responseKey_0.x) === 'bigint' && typeof(responseKey_0.y) === 'bigint' && typeof(responseKey_0.identity) == 'boolean')) {
          __compactRuntime.typeError('initialise',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'erc20-vault.compact line 261 char 1',
                                     'Secp256k1Point',
                                     responseKey_0)
        }
        if (!(typeof(deployerSignature_0) === 'object' && typeof(deployerSignature_0.r) === 'bigint' && deployerSignature_0.r >= 0 && deployerSignature_0.r <= __compactRuntime.MAX_SECP256K1_SCALAR && typeof(deployerSignature_0.s) === 'bigint' && deployerSignature_0.s >= 0 && deployerSignature_0.s <= __compactRuntime.MAX_SECP256K1_SCALAR)) {
          __compactRuntime.typeError('initialise',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'erc20-vault.compact line 261 char 1',
                                     'struct Secp256k1EcdsaSignature<r: Secp256k1Scalar, s: Secp256k1Scalar>',
                                     deployerSignature_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_3.toValue(vaultEvm_0).concat(_descriptor_5.toValue(chainId_0).concat(_descriptor_0.toValue(responseKey_0).concat(_descriptor_7.toValue(deployerSignature_0)))),
            alignment: _descriptor_3.alignment().concat(_descriptor_5.alignment().concat(_descriptor_0.alignment().concat(_descriptor_7.alignment())))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._initialise_0(context,
                                                  partialProofData,
                                                  vaultEvm_0,
                                                  chainId_0,
                                                  responseKey_0,
                                                  deployerSignature_0);
        partialProofData.output = { value: _descriptor_22.toValue(result_0), alignment: _descriptor_22.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      startDeposit: async (...args_1) => {
        if (args_1.length !== 9) {
          throw new __compactRuntime.CompactError(`startDeposit: expected 9 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const evmNonce_0 = args_1[1];
        const gasLimit_0 = args_1[2];
        const maxFeePerGas_0 = args_1[3];
        const maxPriorityFeePerGas_0 = args_1[4];
        const keyVersion_0 = args_1[5];
        const erc20Address_0 = args_1[6];
        const amount_0 = args_1[7];
        const recipient_0 = args_1[8];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 1 (as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(evmNonce_0) === 'bigint' && evmNonce_0 >= 0n && evmNonce_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'Uint<0..18446744073709551616>',
                                     evmNonce_0)
        }
        if (!(typeof(gasLimit_0) === 'bigint' && gasLimit_0 >= 0n && gasLimit_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'Uint<0..18446744073709551616>',
                                     gasLimit_0)
        }
        if (!(typeof(maxFeePerGas_0) === 'bigint' && maxFeePerGas_0 >= 0n && maxFeePerGas_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     maxFeePerGas_0)
        }
        if (!(typeof(maxPriorityFeePerGas_0) === 'bigint' && maxPriorityFeePerGas_0 >= 0n && maxPriorityFeePerGas_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     maxPriorityFeePerGas_0)
        }
        if (!(typeof(keyVersion_0) === 'bigint' && keyVersion_0 >= 0n && keyVersion_0 <= 255n)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 5 (argument 6 as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'Uint<0..256>',
                                     keyVersion_0)
        }
        if (!(erc20Address_0.buffer instanceof ArrayBuffer && erc20Address_0.BYTES_PER_ELEMENT === 1 && erc20Address_0.length === 20)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 6 (argument 7 as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'Bytes<20>',
                                     erc20Address_0)
        }
        if (!(typeof(amount_0) === 'bigint' && amount_0 >= 0n && amount_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 7 (argument 8 as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     amount_0)
        }
        if (!(typeof(recipient_0) === 'object' && typeof(recipient_0.is_left) === 'boolean' && typeof(recipient_0.left) === 'object' && recipient_0.left.bytes.buffer instanceof ArrayBuffer && recipient_0.left.bytes.BYTES_PER_ELEMENT === 1 && recipient_0.left.bytes.length === 32 && typeof(recipient_0.right) === 'object' && recipient_0.right.bytes.buffer instanceof ArrayBuffer && recipient_0.right.bytes.BYTES_PER_ELEMENT === 1 && recipient_0.right.bytes.length === 32)) {
          __compactRuntime.typeError('startDeposit',
                                     'argument 8 (argument 9 as invoked from Typescript)',
                                     'erc20-vault.compact line 288 char 1',
                                     'struct Either<is_left: Boolean, left: struct ZswapCoinPublicKey<bytes: Bytes<32>>, right: struct ContractAddress<bytes: Bytes<32>>>',
                                     recipient_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_5.toValue(evmNonce_0).concat(_descriptor_5.toValue(gasLimit_0).concat(_descriptor_16.toValue(maxFeePerGas_0).concat(_descriptor_16.toValue(maxPriorityFeePerGas_0).concat(_descriptor_4.toValue(keyVersion_0).concat(_descriptor_3.toValue(erc20Address_0).concat(_descriptor_16.toValue(amount_0).concat(_descriptor_10.toValue(recipient_0)))))))),
            alignment: _descriptor_5.alignment().concat(_descriptor_5.alignment().concat(_descriptor_16.alignment().concat(_descriptor_16.alignment().concat(_descriptor_4.alignment().concat(_descriptor_3.alignment().concat(_descriptor_16.alignment().concat(_descriptor_10.alignment())))))))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._startDeposit_0(context,
                                                    partialProofData,
                                                    evmNonce_0,
                                                    gasLimit_0,
                                                    maxFeePerGas_0,
                                                    maxPriorityFeePerGas_0,
                                                    keyVersion_0,
                                                    erc20Address_0,
                                                    amount_0,
                                                    recipient_0);
        partialProofData.output = { value: _descriptor_22.toValue(result_0), alignment: _descriptor_22.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      completeDeposit: async (...args_1) => {
        if (args_1.length !== 5) {
          throw new __compactRuntime.CompactError(`completeDeposit: expected 5 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const requestId_0 = args_1[1];
        const respondBidirectionalEvent_0 = args_1[2];
        const serializedOutput_0 = args_1[3];
        const mintNonce_0 = args_1[4];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('completeDeposit',
                                     'argument 1 (as invoked from Typescript)',
                                     'erc20-vault.compact line 383 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(requestId_0.buffer instanceof ArrayBuffer && requestId_0.BYTES_PER_ELEMENT === 1 && requestId_0.length === 32)) {
          __compactRuntime.typeError('completeDeposit',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'erc20-vault.compact line 383 char 1',
                                     'Bytes<32>',
                                     requestId_0)
        }
        if (!(typeof(respondBidirectionalEvent_0) === 'object' && typeof(respondBidirectionalEvent_0.signature) === 'object' && typeof(respondBidirectionalEvent_0.signature.bigR) === 'object' && respondBidirectionalEvent_0.signature.bigR.x.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.bigR.x.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.bigR.x.length === 32 && respondBidirectionalEvent_0.signature.bigR.y.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.bigR.y.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.bigR.y.length === 32 && respondBidirectionalEvent_0.signature.s.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.s.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.s.length === 32 && typeof(respondBidirectionalEvent_0.signature.recoveryId) === 'bigint' && respondBidirectionalEvent_0.signature.recoveryId >= 0n && respondBidirectionalEvent_0.signature.recoveryId <= 255n)) {
          __compactRuntime.typeError('completeDeposit',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'erc20-vault.compact line 383 char 1',
                                     'struct RespondBidirectionalEvent<signature: struct Signature<bigR: struct AffinePoint<x: Bytes<32>, y: Bytes<32>>, s: Bytes<32>, recoveryId: Uint<0..256>>>',
                                     respondBidirectionalEvent_0)
        }
        if (!(serializedOutput_0.buffer instanceof ArrayBuffer && serializedOutput_0.BYTES_PER_ELEMENT === 1 && serializedOutput_0.length === 1)) {
          __compactRuntime.typeError('completeDeposit',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'erc20-vault.compact line 383 char 1',
                                     'Bytes<1>',
                                     serializedOutput_0)
        }
        if (!(mintNonce_0.buffer instanceof ArrayBuffer && mintNonce_0.BYTES_PER_ELEMENT === 1 && mintNonce_0.length === 32)) {
          __compactRuntime.typeError('completeDeposit',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'erc20-vault.compact line 383 char 1',
                                     'Bytes<32>',
                                     mintNonce_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_1.toValue(requestId_0).concat(_descriptor_30.toValue(respondBidirectionalEvent_0).concat(_descriptor_33.toValue(serializedOutput_0).concat(_descriptor_1.toValue(mintNonce_0)))),
            alignment: _descriptor_1.alignment().concat(_descriptor_30.alignment().concat(_descriptor_33.alignment().concat(_descriptor_1.alignment())))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._completeDeposit_0(context,
                                                       partialProofData,
                                                       requestId_0,
                                                       respondBidirectionalEvent_0,
                                                       serializedOutput_0,
                                                       mintNonce_0);
        partialProofData.output = { value: _descriptor_34.toValue(result_0), alignment: _descriptor_34.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      abandonDeposit: async (...args_1) => {
        if (args_1.length !== 4) {
          throw new __compactRuntime.CompactError(`abandonDeposit: expected 4 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const requestId_0 = args_1[1];
        const respondBidirectionalEvent_0 = args_1[2];
        const serializedOutput_0 = args_1[3];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('abandonDeposit',
                                     'argument 1 (as invoked from Typescript)',
                                     'erc20-vault.compact line 426 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(requestId_0.buffer instanceof ArrayBuffer && requestId_0.BYTES_PER_ELEMENT === 1 && requestId_0.length === 32)) {
          __compactRuntime.typeError('abandonDeposit',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'erc20-vault.compact line 426 char 1',
                                     'Bytes<32>',
                                     requestId_0)
        }
        if (!(typeof(respondBidirectionalEvent_0) === 'object' && typeof(respondBidirectionalEvent_0.signature) === 'object' && typeof(respondBidirectionalEvent_0.signature.bigR) === 'object' && respondBidirectionalEvent_0.signature.bigR.x.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.bigR.x.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.bigR.x.length === 32 && respondBidirectionalEvent_0.signature.bigR.y.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.bigR.y.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.bigR.y.length === 32 && respondBidirectionalEvent_0.signature.s.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.s.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.s.length === 32 && typeof(respondBidirectionalEvent_0.signature.recoveryId) === 'bigint' && respondBidirectionalEvent_0.signature.recoveryId >= 0n && respondBidirectionalEvent_0.signature.recoveryId <= 255n)) {
          __compactRuntime.typeError('abandonDeposit',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'erc20-vault.compact line 426 char 1',
                                     'struct RespondBidirectionalEvent<signature: struct Signature<bigR: struct AffinePoint<x: Bytes<32>, y: Bytes<32>>, s: Bytes<32>, recoveryId: Uint<0..256>>>',
                                     respondBidirectionalEvent_0)
        }
        if (!(serializedOutput_0.buffer instanceof ArrayBuffer && serializedOutput_0.BYTES_PER_ELEMENT === 1 && serializedOutput_0.length === 5)) {
          __compactRuntime.typeError('abandonDeposit',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'erc20-vault.compact line 426 char 1',
                                     'Bytes<5>',
                                     serializedOutput_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_1.toValue(requestId_0).concat(_descriptor_30.toValue(respondBidirectionalEvent_0).concat(_descriptor_31.toValue(serializedOutput_0))),
            alignment: _descriptor_1.alignment().concat(_descriptor_30.alignment().concat(_descriptor_31.alignment()))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._abandonDeposit_0(context,
                                                      partialProofData,
                                                      requestId_0,
                                                      respondBidirectionalEvent_0,
                                                      serializedOutput_0);
        partialProofData.output = { value: _descriptor_22.toValue(result_0), alignment: _descriptor_22.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      startWithdraw: async (...args_1) => {
        if (args_1.length !== 11) {
          throw new __compactRuntime.CompactError(`startWithdraw: expected 11 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const evmNonce_0 = args_1[1];
        const gasLimit_0 = args_1[2];
        const maxFeePerGas_0 = args_1[3];
        const maxPriorityFeePerGas_0 = args_1[4];
        const keyVersion_0 = args_1[5];
        const erc20Address_0 = args_1[6];
        const amount_0 = args_1[7];
        const destEvmAddress_0 = args_1[8];
        const coin_0 = args_1[9];
        const refundRecipient_0 = args_1[10];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 1 (as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(evmNonce_0) === 'bigint' && evmNonce_0 >= 0n && evmNonce_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'Uint<0..18446744073709551616>',
                                     evmNonce_0)
        }
        if (!(typeof(gasLimit_0) === 'bigint' && gasLimit_0 >= 0n && gasLimit_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'Uint<0..18446744073709551616>',
                                     gasLimit_0)
        }
        if (!(typeof(maxFeePerGas_0) === 'bigint' && maxFeePerGas_0 >= 0n && maxFeePerGas_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     maxFeePerGas_0)
        }
        if (!(typeof(maxPriorityFeePerGas_0) === 'bigint' && maxPriorityFeePerGas_0 >= 0n && maxPriorityFeePerGas_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     maxPriorityFeePerGas_0)
        }
        if (!(typeof(keyVersion_0) === 'bigint' && keyVersion_0 >= 0n && keyVersion_0 <= 255n)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 5 (argument 6 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'Uint<0..256>',
                                     keyVersion_0)
        }
        if (!(erc20Address_0.buffer instanceof ArrayBuffer && erc20Address_0.BYTES_PER_ELEMENT === 1 && erc20Address_0.length === 20)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 6 (argument 7 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'Bytes<20>',
                                     erc20Address_0)
        }
        if (!(typeof(amount_0) === 'bigint' && amount_0 >= 0n && amount_0 <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 7 (argument 8 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'Uint<0..340282366920938463463374607431768211456>',
                                     amount_0)
        }
        if (!(destEvmAddress_0.buffer instanceof ArrayBuffer && destEvmAddress_0.BYTES_PER_ELEMENT === 1 && destEvmAddress_0.length === 20)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 8 (argument 9 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'Bytes<20>',
                                     destEvmAddress_0)
        }
        if (!(typeof(coin_0) === 'object' && coin_0.nonce.buffer instanceof ArrayBuffer && coin_0.nonce.BYTES_PER_ELEMENT === 1 && coin_0.nonce.length === 32 && coin_0.color.buffer instanceof ArrayBuffer && coin_0.color.BYTES_PER_ELEMENT === 1 && coin_0.color.length === 32 && typeof(coin_0.value) === 'bigint' && coin_0.value >= 0n && coin_0.value <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 9 (argument 10 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'struct ShieldedCoinInfo<nonce: Bytes<32>, color: Bytes<32>, value: Uint<0..340282366920938463463374607431768211456>>',
                                     coin_0)
        }
        if (!(typeof(refundRecipient_0) === 'object' && typeof(refundRecipient_0.is_left) === 'boolean' && typeof(refundRecipient_0.left) === 'object' && refundRecipient_0.left.bytes.buffer instanceof ArrayBuffer && refundRecipient_0.left.bytes.BYTES_PER_ELEMENT === 1 && refundRecipient_0.left.bytes.length === 32 && typeof(refundRecipient_0.right) === 'object' && refundRecipient_0.right.bytes.buffer instanceof ArrayBuffer && refundRecipient_0.right.bytes.BYTES_PER_ELEMENT === 1 && refundRecipient_0.right.bytes.length === 32)) {
          __compactRuntime.typeError('startWithdraw',
                                     'argument 10 (argument 11 as invoked from Typescript)',
                                     'erc20-vault.compact line 454 char 1',
                                     'struct Either<is_left: Boolean, left: struct ZswapCoinPublicKey<bytes: Bytes<32>>, right: struct ContractAddress<bytes: Bytes<32>>>',
                                     refundRecipient_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_5.toValue(evmNonce_0).concat(_descriptor_5.toValue(gasLimit_0).concat(_descriptor_16.toValue(maxFeePerGas_0).concat(_descriptor_16.toValue(maxPriorityFeePerGas_0).concat(_descriptor_4.toValue(keyVersion_0).concat(_descriptor_3.toValue(erc20Address_0).concat(_descriptor_16.toValue(amount_0).concat(_descriptor_3.toValue(destEvmAddress_0).concat(_descriptor_32.toValue(coin_0).concat(_descriptor_10.toValue(refundRecipient_0)))))))))),
            alignment: _descriptor_5.alignment().concat(_descriptor_5.alignment().concat(_descriptor_16.alignment().concat(_descriptor_16.alignment().concat(_descriptor_4.alignment().concat(_descriptor_3.alignment().concat(_descriptor_16.alignment().concat(_descriptor_3.alignment().concat(_descriptor_32.alignment().concat(_descriptor_10.alignment())))))))))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._startWithdraw_0(context,
                                                     partialProofData,
                                                     evmNonce_0,
                                                     gasLimit_0,
                                                     maxFeePerGas_0,
                                                     maxPriorityFeePerGas_0,
                                                     keyVersion_0,
                                                     erc20Address_0,
                                                     amount_0,
                                                     destEvmAddress_0,
                                                     coin_0,
                                                     refundRecipient_0);
        partialProofData.output = { value: _descriptor_22.toValue(result_0), alignment: _descriptor_22.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      completeWithdraw: async (...args_1) => {
        if (args_1.length !== 5) {
          throw new __compactRuntime.CompactError(`completeWithdraw: expected 5 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const requestId_0 = args_1[1];
        const respondBidirectionalEvent_0 = args_1[2];
        const serializedOutput_0 = args_1[3];
        const mintNonce_0 = args_1[4];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('completeWithdraw',
                                     'argument 1 (as invoked from Typescript)',
                                     'erc20-vault.compact line 548 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(requestId_0.buffer instanceof ArrayBuffer && requestId_0.BYTES_PER_ELEMENT === 1 && requestId_0.length === 32)) {
          __compactRuntime.typeError('completeWithdraw',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'erc20-vault.compact line 548 char 1',
                                     'Bytes<32>',
                                     requestId_0)
        }
        if (!(typeof(respondBidirectionalEvent_0) === 'object' && typeof(respondBidirectionalEvent_0.signature) === 'object' && typeof(respondBidirectionalEvent_0.signature.bigR) === 'object' && respondBidirectionalEvent_0.signature.bigR.x.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.bigR.x.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.bigR.x.length === 32 && respondBidirectionalEvent_0.signature.bigR.y.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.bigR.y.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.bigR.y.length === 32 && respondBidirectionalEvent_0.signature.s.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.s.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.s.length === 32 && typeof(respondBidirectionalEvent_0.signature.recoveryId) === 'bigint' && respondBidirectionalEvent_0.signature.recoveryId >= 0n && respondBidirectionalEvent_0.signature.recoveryId <= 255n)) {
          __compactRuntime.typeError('completeWithdraw',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'erc20-vault.compact line 548 char 1',
                                     'struct RespondBidirectionalEvent<signature: struct Signature<bigR: struct AffinePoint<x: Bytes<32>, y: Bytes<32>>, s: Bytes<32>, recoveryId: Uint<0..256>>>',
                                     respondBidirectionalEvent_0)
        }
        if (!(serializedOutput_0.buffer instanceof ArrayBuffer && serializedOutput_0.BYTES_PER_ELEMENT === 1 && serializedOutput_0.length === 1)) {
          __compactRuntime.typeError('completeWithdraw',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'erc20-vault.compact line 548 char 1',
                                     'Bytes<1>',
                                     serializedOutput_0)
        }
        if (!(mintNonce_0.buffer instanceof ArrayBuffer && mintNonce_0.BYTES_PER_ELEMENT === 1 && mintNonce_0.length === 32)) {
          __compactRuntime.typeError('completeWithdraw',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'erc20-vault.compact line 548 char 1',
                                     'Bytes<32>',
                                     mintNonce_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_1.toValue(requestId_0).concat(_descriptor_30.toValue(respondBidirectionalEvent_0).concat(_descriptor_33.toValue(serializedOutput_0).concat(_descriptor_1.toValue(mintNonce_0)))),
            alignment: _descriptor_1.alignment().concat(_descriptor_30.alignment().concat(_descriptor_33.alignment().concat(_descriptor_1.alignment())))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._completeWithdraw_0(context,
                                                        partialProofData,
                                                        requestId_0,
                                                        respondBidirectionalEvent_0,
                                                        serializedOutput_0,
                                                        mintNonce_0);
        partialProofData.output = { value: _descriptor_34.toValue(result_0), alignment: _descriptor_34.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      refundWithdraw: async (...args_1) => {
        if (args_1.length !== 5) {
          throw new __compactRuntime.CompactError(`refundWithdraw: expected 5 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const requestId_0 = args_1[1];
        const respondBidirectionalEvent_0 = args_1[2];
        const serializedOutput_0 = args_1[3];
        const mintNonce_0 = args_1[4];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('refundWithdraw',
                                     'argument 1 (as invoked from Typescript)',
                                     'erc20-vault.compact line 592 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(requestId_0.buffer instanceof ArrayBuffer && requestId_0.BYTES_PER_ELEMENT === 1 && requestId_0.length === 32)) {
          __compactRuntime.typeError('refundWithdraw',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'erc20-vault.compact line 592 char 1',
                                     'Bytes<32>',
                                     requestId_0)
        }
        if (!(typeof(respondBidirectionalEvent_0) === 'object' && typeof(respondBidirectionalEvent_0.signature) === 'object' && typeof(respondBidirectionalEvent_0.signature.bigR) === 'object' && respondBidirectionalEvent_0.signature.bigR.x.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.bigR.x.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.bigR.x.length === 32 && respondBidirectionalEvent_0.signature.bigR.y.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.bigR.y.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.bigR.y.length === 32 && respondBidirectionalEvent_0.signature.s.buffer instanceof ArrayBuffer && respondBidirectionalEvent_0.signature.s.BYTES_PER_ELEMENT === 1 && respondBidirectionalEvent_0.signature.s.length === 32 && typeof(respondBidirectionalEvent_0.signature.recoveryId) === 'bigint' && respondBidirectionalEvent_0.signature.recoveryId >= 0n && respondBidirectionalEvent_0.signature.recoveryId <= 255n)) {
          __compactRuntime.typeError('refundWithdraw',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'erc20-vault.compact line 592 char 1',
                                     'struct RespondBidirectionalEvent<signature: struct Signature<bigR: struct AffinePoint<x: Bytes<32>, y: Bytes<32>>, s: Bytes<32>, recoveryId: Uint<0..256>>>',
                                     respondBidirectionalEvent_0)
        }
        if (!(serializedOutput_0.buffer instanceof ArrayBuffer && serializedOutput_0.BYTES_PER_ELEMENT === 1 && serializedOutput_0.length === 5)) {
          __compactRuntime.typeError('refundWithdraw',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'erc20-vault.compact line 592 char 1',
                                     'Bytes<5>',
                                     serializedOutput_0)
        }
        if (!(mintNonce_0.buffer instanceof ArrayBuffer && mintNonce_0.BYTES_PER_ELEMENT === 1 && mintNonce_0.length === 32)) {
          __compactRuntime.typeError('refundWithdraw',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'erc20-vault.compact line 592 char 1',
                                     'Bytes<32>',
                                     mintNonce_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_1.toValue(requestId_0).concat(_descriptor_30.toValue(respondBidirectionalEvent_0).concat(_descriptor_31.toValue(serializedOutput_0).concat(_descriptor_1.toValue(mintNonce_0)))),
            alignment: _descriptor_1.alignment().concat(_descriptor_30.alignment().concat(_descriptor_31.alignment().concat(_descriptor_1.alignment())))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._refundWithdraw_0(context,
                                                      partialProofData,
                                                      requestId_0,
                                                      respondBidirectionalEvent_0,
                                                      serializedOutput_0,
                                                      mintNonce_0);
        partialProofData.output = { value: _descriptor_32.toValue(result_0), alignment: _descriptor_32.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      async tokenMetadataDigest(context, ...args_1) {
        return { result: pureCircuits.tokenMetadataDigest(...args_1), context };
      },
      publishTokenMetadata: async (...args_1) => {
        if (args_1.length !== 9) {
          throw new __compactRuntime.CompactError(`publishTokenMetadata: expected 9 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const erc20Address_0 = args_1[1];
        const name_0 = args_1[2];
        const nameLen_0 = args_1[3];
        const symbol_0 = args_1[4];
        const symbolLen_0 = args_1[5];
        const decimals_0 = args_1[6];
        const validUntil_0 = args_1[7];
        const adminSignature_0 = args_1[8];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 1 (as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(erc20Address_0.buffer instanceof ArrayBuffer && erc20Address_0.BYTES_PER_ELEMENT === 1 && erc20Address_0.length === 20)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'Bytes<20>',
                                     erc20Address_0)
        }
        if (!(name_0.buffer instanceof ArrayBuffer && name_0.BYTES_PER_ELEMENT === 1 && name_0.length === 32)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'Bytes<32>',
                                     name_0)
        }
        if (!(typeof(nameLen_0) === 'bigint' && nameLen_0 >= 0n && nameLen_0 <= 255n)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'Uint<0..256>',
                                     nameLen_0)
        }
        if (!(symbol_0.buffer instanceof ArrayBuffer && symbol_0.BYTES_PER_ELEMENT === 1 && symbol_0.length === 32)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'Bytes<32>',
                                     symbol_0)
        }
        if (!(typeof(symbolLen_0) === 'bigint' && symbolLen_0 >= 0n && symbolLen_0 <= 255n)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 5 (argument 6 as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'Uint<0..256>',
                                     symbolLen_0)
        }
        if (!(typeof(decimals_0) === 'bigint' && decimals_0 >= 0n && decimals_0 <= 255n)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 6 (argument 7 as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'Uint<0..256>',
                                     decimals_0)
        }
        if (!(typeof(validUntil_0) === 'bigint' && validUntil_0 >= 0n && validUntil_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 7 (argument 8 as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'Uint<0..18446744073709551616>',
                                     validUntil_0)
        }
        if (!(typeof(adminSignature_0) === 'object' && typeof(adminSignature_0.r) === 'bigint' && adminSignature_0.r >= 0 && adminSignature_0.r <= __compactRuntime.MAX_SECP256K1_SCALAR && typeof(adminSignature_0.s) === 'bigint' && adminSignature_0.s >= 0 && adminSignature_0.s <= __compactRuntime.MAX_SECP256K1_SCALAR)) {
          __compactRuntime.typeError('publishTokenMetadata',
                                     'argument 8 (argument 9 as invoked from Typescript)',
                                     'erc20-vault.compact line 663 char 1',
                                     'struct Secp256k1EcdsaSignature<r: Secp256k1Scalar, s: Secp256k1Scalar>',
                                     adminSignature_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_3.toValue(erc20Address_0).concat(_descriptor_1.toValue(name_0).concat(_descriptor_4.toValue(nameLen_0).concat(_descriptor_1.toValue(symbol_0).concat(_descriptor_4.toValue(symbolLen_0).concat(_descriptor_4.toValue(decimals_0).concat(_descriptor_5.toValue(validUntil_0).concat(_descriptor_7.toValue(adminSignature_0)))))))),
            alignment: _descriptor_3.alignment().concat(_descriptor_1.alignment().concat(_descriptor_4.alignment().concat(_descriptor_1.alignment().concat(_descriptor_4.alignment().concat(_descriptor_4.alignment().concat(_descriptor_5.alignment().concat(_descriptor_7.alignment())))))))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._publishTokenMetadata_0(context,
                                                            partialProofData,
                                                            erc20Address_0,
                                                            name_0,
                                                            nameLen_0,
                                                            symbol_0,
                                                            symbolLen_0,
                                                            decimals_0,
                                                            validUntil_0,
                                                            adminSignature_0);
        partialProofData.output = { value: _descriptor_22.toValue(result_0), alignment: _descriptor_22.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      }
    };
    this.impureCircuits = {
      initialise: this.circuits.initialise,
      startDeposit: this.circuits.startDeposit,
      completeDeposit: this.circuits.completeDeposit,
      abandonDeposit: this.circuits.abandonDeposit,
      startWithdraw: this.circuits.startWithdraw,
      completeWithdraw: this.circuits.completeWithdraw,
      refundWithdraw: this.circuits.refundWithdraw,
      publishTokenMetadata: this.circuits.publishTokenMetadata
    };
    this.provableCircuits = {
      initialise: this.circuits.initialise,
      startDeposit: this.circuits.startDeposit,
      completeDeposit: this.circuits.completeDeposit,
      abandonDeposit: this.circuits.abandonDeposit,
      startWithdraw: this.circuits.startWithdraw,
      completeWithdraw: this.circuits.completeWithdraw,
      refundWithdraw: this.circuits.refundWithdraw,
      publishTokenMetadata: this.circuits.publishTokenMetadata
    };
  }
  async initialState(...args_0) {
    if (args_0.length !== 3) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 3 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const constructorContext_0 = args_0[0];
    const deployerPublicKey_0 = args_0[1];
    const signetContract_0 = args_0[2];
    if (typeof(constructorContext_0) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'constructorContext' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!('initialZswapLocalState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript)`);
    }
    if (typeof(constructorContext_0.initialZswapLocalState) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!(typeof(deployerPublicKey_0.x) === 'bigint' && typeof(deployerPublicKey_0.y) === 'bigint' && typeof(deployerPublicKey_0.identity) == 'boolean')) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 1 (argument 2 as invoked from Typescript)',
                                 'erc20-vault.compact line 245 char 1',
                                 'Secp256k1Point',
                                 deployerPublicKey_0)
    }
    if (!(typeof(signetContract_0) === 'object' && signetContract_0.bytes.buffer instanceof ArrayBuffer && signetContract_0.bytes.BYTES_PER_ELEMENT === 1 && signetContract_0.bytes.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 2 (argument 3 as invoked from Typescript)',
                                 'erc20-vault.compact line 245 char 1',
                                 'contract SignetSigner[signBidirectional(Bytes<32>, struct SignBidirectionalEventNotification<version: Uint<0..256>, payload: Bytes<128>>): []]',
                                 signetContract_0)
    }
    const state_0 = new __compactRuntime.ContractState();
    let stateValue_0 = __compactRuntime.StateValue.newArray();
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    state_0.data = new __compactRuntime.ChargedState(stateValue_0);
    state_0.setOperation('initialise', new __compactRuntime.ContractOperation());
    state_0.setOperation('startDeposit', new __compactRuntime.ContractOperation());
    state_0.setOperation('completeDeposit', new __compactRuntime.ContractOperation());
    state_0.setOperation('abandonDeposit', new __compactRuntime.ContractOperation());
    state_0.setOperation('startWithdraw', new __compactRuntime.ContractOperation());
    state_0.setOperation('completeWithdraw', new __compactRuntime.ContractOperation());
    state_0.setOperation('refundWithdraw', new __compactRuntime.ContractOperation());
    state_0.setOperation('publishTokenMetadata', new __compactRuntime.ContractOperation());
    const context = __compactRuntime.createCircuitContext('constructor', __compactRuntime.dummyContractAddress(), constructorContext_0.initialZswapLocalState.coinPublicKey, state_0.data, constructorContext_0.initialPrivateState);
    const partialProofData = {
      input: { value: [], alignment: [] },
      output: undefined,
      publicTranscript: [],
      privateTranscriptOutputs: []
    };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(0n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(1n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(2n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(3n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(4n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue({ bytes: new Uint8Array(32) }),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(5n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(({x: 0n, y: 0n, identity: true})),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(6n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(0n),
                                                                                              alignment: _descriptor_5.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(7n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(0n),
                                                                                              alignment: _descriptor_5.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(8n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(new Uint8Array(20)),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(9n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(0n),
                                                                                              alignment: _descriptor_5.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(10n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(({x: 0n, y: 0n, identity: true})),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(10n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(deployerPublicKey_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(4n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(signetContract_0),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    state_0.data = new __compactRuntime.ChargedState(context.callContext.currentQueryContext.state.state);
    return {
      currentContractState: state_0,
      currentPrivateState: context.callContext.currentPrivateState,
      currentZswapLocalState: context.callContext.currentZswapLocalState
    }
  }
  _some_0(value_0) { return { is_some: true, value: value_0 }; }
  _some_1(value_0) { return { is_some: true, value: value_0 }; }
  _none_0() {
    return { is_some: false,
             value:
               { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 0n } };
  }
  _right_0(value_0) {
    return { is_left: false, left: { bytes: new Uint8Array(32) }, right: value_0 };
  }
  _tokenType_0(domain_sep_0, contractAddress_0) {
    return this._persistentCommit_0([domain_sep_0, contractAddress_0.bytes],
                                    new Uint8Array([109, 105, 100, 110, 105, 103, 104, 116, 58, 100, 101, 114, 105, 118, 101, 95, 116, 111, 107, 101, 110, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  }
  async _mintShieldedToken_0(context,
                             partialProofData,
                             domain_sep_0,
                             value_0,
                             nonce_0,
                             recipient_0)
  {
    const coin_0 = { nonce: nonce_0,
                     color:
                       this._tokenType_0(domain_sep_0,
                                         _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                   partialProofData,
                                                                                                   [
                                                                                                    { dup: { n: 2 } },
                                                                                                    { idx: { cached: true,
                                                                                                             pushPath: false,
                                                                                                             path: [
                                                                                                                    { tag: 'value',
                                                                                                                      value: { value: _descriptor_4.toValue(0n),
                                                                                                                               alignment: _descriptor_4.alignment() } }] } },
                                                                                                    { popeq: { cached: true,
                                                                                                               result: undefined } }]).value)),
                     value: value_0 };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(4n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(domain_sep_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { dup: { n: 1 } },
                                       { dup: { n: 1 } },
                                       'member',
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(value_0),
                                                                                              alignment: _descriptor_5.alignment() }).encode() } },
                                       { swap: { n: 0 } },
                                       'neg',
                                       { branch: { skip: 4 } },
                                       { dup: { n: 2 } },
                                       { dup: { n: 2 } },
                                       { idx: { cached: true,
                                                pushPath: false,
                                                path: [ { tag: 'stack' }] } },
                                       'add',
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    this._createZswapOutput_0(context, partialProofData, coin_0, recipient_0);
    const cm_0 = this._coinCommitment_0(coin_0, recipient_0);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(2n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(cm_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newNull().encode() } },
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    if (!recipient_0.is_left
        &&
        this._equal_0(recipient_0.right.bytes,
                      _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                partialProofData,
                                                                                [
                                                                                 { dup: { n: 2 } },
                                                                                 { idx: { cached: true,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_4.toValue(0n),
                                                                                                            alignment: _descriptor_4.alignment() } }] } },
                                                                                 { popeq: { cached: true,
                                                                                            result: undefined } }]).value).bytes))
    {
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { swap: { n: 0 } },
                                         { idx: { cached: true,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_4.toValue(1n),
                                                                    alignment: _descriptor_4.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(cm_0),
                                                                                                alignment: _descriptor_1.alignment() }).encode() } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newNull().encode() } },
                                         { ins: { cached: true, n: 2 } },
                                         { swap: { n: 0 } }]);
    }
    return coin_0;
  }
  async _receiveShielded_0(context, partialProofData, coin_0) {
    const recipient_0 = this._right_0(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                partialProofData,
                                                                                                [
                                                                                                 { dup: { n: 2 } },
                                                                                                 { idx: { cached: true,
                                                                                                          pushPath: false,
                                                                                                          path: [
                                                                                                                 { tag: 'value',
                                                                                                                   value: { value: _descriptor_4.toValue(0n),
                                                                                                                            alignment: _descriptor_4.alignment() } }] } },
                                                                                                 { popeq: { cached: true,
                                                                                                            result: undefined } }]).value));
    this._createZswapOutput_0(context, partialProofData, coin_0, recipient_0);
    const tmp_0 = this._coinCommitment_0(coin_0, recipient_0);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(1n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(tmp_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newNull().encode() } },
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    return [];
  }
  _coinCommitment_0(coin_0, recipient_0) {
    return this._persistentHash_2({ domain_sep:
                                      new Uint8Array([109, 105, 100, 110, 105, 103, 104, 116, 58, 122, 115, 119, 97, 112, 45, 99, 99, 91, 118, 49, 93]),
                                    info: coin_0,
                                    dataType: recipient_0.is_left,
                                    data:
                                      recipient_0.is_left ?
                                      recipient_0.left.bytes :
                                      recipient_0.right.bytes });
  }
  async _blockTimeLt_0(context, partialProofData, time_0) {
    return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                     partialProofData,
                                                                     [
                                                                      { dup: { n: 2 } },
                                                                      { idx: { cached: true,
                                                                               pushPath: false,
                                                                               path: [
                                                                                      { tag: 'value',
                                                                                        value: { value: _descriptor_4.toValue(2n),
                                                                                                 alignment: _descriptor_4.alignment() } }] } },
                                                                      { push: { storage: false,
                                                                                value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(time_0),
                                                                                                                             alignment: _descriptor_5.alignment() }).encode() } },
                                                                      'lt',
                                                                      { popeq: { cached: true,
                                                                                 result: undefined } }]).value);
  }
  _hashToSecp256k1Scalar_0(digest_0) {
    const v_0 = Array.from(digest_0, BigInt);
    const beReversed_0 = Uint8Array.from([v_0[31],
                                          v_0[30],
                                          v_0[29],
                                          v_0[28],
                                          v_0[27],
                                          v_0[26],
                                          v_0[25],
                                          v_0[24],
                                          v_0[23],
                                          v_0[22],
                                          v_0[21],
                                          v_0[20],
                                          v_0[19],
                                          v_0[18],
                                          v_0[17],
                                          v_0[16],
                                          v_0[15],
                                          v_0[14],
                                          v_0[13],
                                          v_0[12],
                                          v_0[11],
                                          v_0[10],
                                          v_0[9],
                                          v_0[8],
                                          v_0[7],
                                          v_0[6],
                                          v_0[5],
                                          v_0[4],
                                          v_0[3],
                                          v_0[2],
                                          v_0[1],
                                          v_0[0]],
                                         Number);
    return __compactRuntime.convertBytesToField(115792089237316195423570985008687907852837564279074904382605163141518161494336n,
                                                32,
                                                beReversed_0,
                                                'Secp256k1Scalar',
                                                '<standard library>');
  }
  _secp256k1EcdsaVerify_0(msgHash_0, sig_0, pk_0) {
    const z_0 = this._hashToSecp256k1Scalar_0(msgHash_0);
    const __compact_pattern_tmp1_0 = sig_0;
    const r_0 = __compact_pattern_tmp1_0.r;
    const s_0 = __compact_pattern_tmp1_0.s;
    const w_0 = this._inv_0(s_0);
    const u1_0 = __compactRuntime.secp256k1ScalarMul(z_0, w_0);
    const u2_0 = __compactRuntime.secp256k1ScalarMul(r_0, w_0);
    const point_0 = this._ecAdd_0(this._ecMulGenerator_0(u1_0),
                                  this._ecMul_0(pk_0, u2_0));
    return __compactRuntime.convertBytesToField(115792089237316195423570985008687907852837564279074904382605163141518161494336n,
                                                32,
                                                __compactRuntime.convertBigintToBytes(32,
                                                                                      this._secp256k1PointX_0(point_0),
                                                                                      '<standard library>'),
                                                'Secp256k1Scalar',
                                                '<standard library>')
           ===
           r_0;
  }
  _transientHash_0(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_19, value_0);
    return result_0;
  }
  _transientHash_1(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_27, value_0);
    return result_0;
  }
  _transientHash_2(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_50, value_0);
    return result_0;
  }
  _transientHash_3(value_0) {
    const result_0 = __compactRuntime.transientHash(_descriptor_48, value_0);
    return result_0;
  }
  _persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_49, value_0);
    return result_0;
  }
  _persistentHash_1(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_45, value_0);
    return result_0;
  }
  _persistentHash_2(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_47, value_0);
    return result_0;
  }
  _persistentHash_3(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_44, value_0);
    return result_0;
  }
  _persistentCommit_0(value_0, rand_0) {
    const result_0 = __compactRuntime.persistentCommit(_descriptor_19,
                                                       value_0,
                                                       rand_0);
    return result_0;
  }
  _upgradeFromTransient_0(x_0) {
    const result_0 = __compactRuntime.upgradeFromTransient(x_0);
    return result_0;
  }
  _createZswapOutput_0(context, partialProofData, coin_0, recipient_0) {
    const result_0 = __compactRuntime.createZswapOutput(context,
                                                        coin_0,
                                                        recipient_0);
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_22.toValue(result_0),
      alignment: _descriptor_22.alignment()
    });
    return result_0;
  }
  _inv_0(s_0) {
    const result_0 = __compactRuntime.secp256k1ScalarInv(s_0);
    return result_0;
  }
  _secp256k1PointX_0(pt_0) {
    const result_0 = __compactRuntime.secp256k1PointX(pt_0);
    return result_0;
  }
  _ecAdd_0(a_0, b_0) {
    const result_0 = __compactRuntime.secp256k1Add(a_0, b_0);
    return result_0;
  }
  _ecMul_0(a_0, b_0) {
    const result_0 = __compactRuntime.secp256k1Mul(a_0, b_0);
    return result_0;
  }
  _ecMulGenerator_0(b_0) {
    const result_0 = __compactRuntime.secp256k1MulGenerator(b_0);
    return result_0;
  }
  _deserialize_0(value_0) { return { success: BigInt(value_0[0n]) === 1n }; }
  _constructSignBidirectionalEvent_0(sender_0,
                                     requestNonce_0,
                                     keyVersion_0,
                                     path_0,
                                     algo_0,
                                     dest_0,
                                     params_0,
                                     txParamType_0,
                                     txParams_0,
                                     caip2Id_0,
                                     outputDeserializationSchema_0,
                                     respondSerializationSchema_0)
  {
    __compactRuntime.assert(keyVersion_0 >= 1n, 'keyVersion must be >= 1');
    return { sender: sender_0,
             requestNonce: requestNonce_0,
             keyVersion: keyVersion_0,
             path: path_0,
             algo: algo_0,
             dest: dest_0,
             params: params_0,
             txParamType: txParamType_0,
             txParams: txParams_0,
             caip2Id: caip2Id_0,
             outputDeserializationSchema: outputDeserializationSchema_0,
             respondSerializationSchema: respondSerializationSchema_0 };
  }
  _calculateRequestId_0(request_0) {
    return this._upgradeFromTransient_0(this._transientHash_1(request_0));
  }
  _constructSignBidirectionalEventNotificationV1_0(callerAddress_0,
                                                   requestsPathDepth_0,
                                                   requestsPath_0)
  {
    return { version: 1n,
             payload:
               Uint8Array.from([...Array.from(callerAddress_0.bytes, BigInt),
                                requestsPathDepth_0,
                                requestsPath_0[0],
                                requestsPath_0[1],
                                requestsPath_0[2],
                                requestsPath_0[3],
                                ...Array.from(new Uint8Array(91), BigInt)],
                               Number) };
  }
  _calculateSignetAttestationDigest_0(requestId_0, serializedOutput_0) {
    return this._upgradeFromTransient_0(this._transientHash_2([requestId_0,
                                                               1n,
                                                               serializedOutput_0]));
  }
  _calculateSignetAttestationDigest_1(requestId_0, serializedOutput_0) {
    return this._upgradeFromTransient_0(this._transientHash_3([requestId_0,
                                                               5n,
                                                               serializedOutput_0]));
  }
  _verifyRespondBidirectionalEvent_0(requestId_0,
                                     serializedOutput_0,
                                     respondBidirectionalEvent_0,
                                     mpcResponseKey_0)
  {
    const digest_0 = this._calculateSignetAttestationDigest_0(requestId_0,
                                                              serializedOutput_0);
    return this._secp256k1EcdsaVerify_0(digest_0,
                                        { r:
                                            __compactRuntime.convertBytesToField(115792089237316195423570985008687907852837564279074904382605163141518161494336n,
                                                                                 32,
                                                                                 respondBidirectionalEvent_0.signature.bigR.x,
                                                                                 'Secp256k1Scalar',
                                                                                 'Signet.compact line 347 char 12'),
                                          s:
                                            __compactRuntime.convertBytesToField(115792089237316195423570985008687907852837564279074904382605163141518161494336n,
                                                                                 32,
                                                                                 respondBidirectionalEvent_0.signature.s,
                                                                                 'Secp256k1Scalar',
                                                                                 'Signet.compact line 348 char 12') },
                                        mpcResponseKey_0);
  }
  _verifyRespondBidirectionalEvent_1(requestId_0,
                                     serializedOutput_0,
                                     respondBidirectionalEvent_0,
                                     mpcResponseKey_0)
  {
    const digest_0 = this._calculateSignetAttestationDigest_1(requestId_0,
                                                              serializedOutput_0);
    return this._secp256k1EcdsaVerify_0(digest_0,
                                        { r:
                                            __compactRuntime.convertBytesToField(115792089237316195423570985008687907852837564279074904382605163141518161494336n,
                                                                                 32,
                                                                                 respondBidirectionalEvent_0.signature.bigR.x,
                                                                                 'Secp256k1Scalar',
                                                                                 'Signet.compact line 347 char 12'),
                                          s:
                                            __compactRuntime.convertBytesToField(115792089237316195423570985008687907852837564279074904382605163141518161494336n,
                                                                                 32,
                                                                                 respondBidirectionalEvent_0.signature.s,
                                                                                 'Secp256k1Scalar',
                                                                                 'Signet.compact line 348 char 12') },
                                        mpcResponseKey_0);
  }
  _ethereumCaip2Id_0() {
    return new Uint8Array([101, 105, 112, 49, 53, 53, 58, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  _evmAddressAbiWord_0(addr_0) {
    return Uint8Array.from([...Array.from(new Uint8Array(12), BigInt),
                            ...Array.from(addr_0, BigInt)],
                           Number);
  }
  _numericAbiWord_0(value_0) {
    const le_0 = Array.from(__compactRuntime.convertBigintToBytes(16,
                                                                  value_0,
                                                                  'Signet.compact line 437 char 17'),
                            BigInt);
    return Uint8Array.from([...Array.from(new Uint8Array(16), BigInt),
                            le_0[15],
                            le_0[14],
                            le_0[13],
                            le_0[12],
                            le_0[11],
                            le_0[10],
                            le_0[9],
                            le_0[8],
                            le_0[7],
                            le_0[6],
                            le_0[5],
                            le_0[4],
                            le_0[3],
                            le_0[2],
                            le_0[1],
                            le_0[0]],
                           Number);
  }
  _EVENT_NAME_0() {
    return new Uint8Array([109, 105, 112, 45, 48, 48, 49, 56, 58, 116, 111, 107, 101, 110, 45, 109, 101, 116, 97, 100, 97, 116, 97, 91, 118, 49, 93, 0, 0, 0, 0, 0]);
  }
  _KIND_SHIELDED_0() { return 1n; }
  _VAL_TYPE_STRING_0() { return 1n; }
  _VAL_TYPE_INTEGER_0() { return 2n; }
  async _emitTokenMetadata_0(context,
                             partialProofData,
                             domainSep_0,
                             kind_0,
                             key_0,
                             valType_0,
                             valLen_0,
                             value_0)
  {
    let t_0;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newArray()
                                                          .arrayPush(__compactRuntime.StateValue.newCell({ value: _descriptor_52.toValue(1n),
                                                                                                           alignment: _descriptor_52.alignment() })).arrayPush(__compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(10n),
                                                                                                                                                                                                     alignment: _descriptor_4.alignment() })).arrayPush(__compactRuntime.StateValue.newCell({ value: _descriptor_36.toValue((t_0 = { name:
                                                                                                                                                                                                                                                                                                                                       this._EVENT_NAME_0(),
                                                                                                                                                                                                                                                                                                                                     payload:
                                                                                                                                                                                                                                                                                                                                       Uint8Array.from([...Array.from(domainSep_0,
                                                                                                                                                                                                                                                                                                                                                                      BigInt),
                                                                                                                                                                                                                                                                                                                                                        kind_0,
                                                                                                                                                                                                                                                                                                                                                        ...Array.from(key_0,
                                                                                                                                                                                                                                                                                                                                                                      BigInt),
                                                                                                                                                                                                                                                                                                                                                        valType_0,
                                                                                                                                                                                                                                                                                                                                                        valLen_0,
                                                                                                                                                                                                                                                                                                                                                        ...Array.from(value_0,
                                                                                                                                                                                                                                                                                                                                                                      BigInt)],
                                                                                                                                                                                                                                                                                                                                                       Number) },
                                                                                                                                                                                                                                                                                                                             Uint8Array.from([...Array.from(t_0.name,
                                                                                                                                                                                                                                                                                                                                                            BigInt),
                                                                                                                                                                                                                                                                                                                                              ...Array.from(t_0.payload,
                                                                                                                                                                                                                                                                                                                                                            BigInt)],
                                                                                                                                                                                                                                                                                                                                             Number))),
                                                                                                                                                                                                                                                                                              alignment: _descriptor_36.alignment() }))
                                                          .encode() } },
                                       'log']);
    return [];
  }
  async _emitStandardFields_0(context,
                              partialProofData,
                              domainSep_0,
                              kind_0,
                              name__0,
                              nameLen_0,
                              symbol__0,
                              symbolLen_0,
                              decimals__0)
  {
    await this._emitTokenMetadata_0(context,
                                    partialProofData,
                                    domainSep_0,
                                    kind_0,
                                    new Uint8Array([110, 97, 109, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                    this._VAL_TYPE_STRING_0(),
                                    nameLen_0,
                                    Uint8Array.from([...Array.from(name__0,
                                                                   BigInt),
                                                     ...Array.from(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                                                   BigInt)],
                                                    Number));
    await this._emitTokenMetadata_0(context,
                                    partialProofData,
                                    domainSep_0,
                                    kind_0,
                                    new Uint8Array([115, 121, 109, 98, 111, 108, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                    this._VAL_TYPE_STRING_0(),
                                    symbolLen_0,
                                    Uint8Array.from([...Array.from(symbol__0,
                                                                   BigInt),
                                                     ...Array.from(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                                                   BigInt)],
                                                    Number));
    await this._emitTokenMetadata_0(context,
                                    partialProofData,
                                    domainSep_0,
                                    kind_0,
                                    new Uint8Array([100, 101, 99, 105, 109, 97, 108, 115, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                    this._VAL_TYPE_INTEGER_0(),
                                    16n,
                                    Uint8Array.from([decimals__0,
                                                     ...Array.from(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                                                   BigInt)],
                                                    Number));
    return [];
  }
  _vaultResponseSchema_0() {
    return new Uint8Array([91, 123, 34, 110, 97, 109, 101, 34, 58, 34, 115, 117, 99, 99, 101, 115, 115, 34, 44, 34, 116, 121, 112, 101, 34, 58, 34, 98, 111, 111, 108, 34, 125, 93]);
  }
  _vaultTokenDomainSeparator_0(erc20Address_0) {
    return this._upgradeFromTransient_0(this._transientHash_0([new Uint8Array([101, 114, 99, 50, 48, 58, 118, 97, 117, 108, 116, 58, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                                               __compactRuntime.convertBigintToBytes(32,
                                                                                                     __compactRuntime.convertBytesToUint(52435875175126190479447740508185965837690552500527637822603658699938581184512n,
                                                                                                                                         20,
                                                                                                                                         erc20Address_0,
                                                                                                                                         'Field',
                                                                                                                                         'erc20-vault.compact line 169 char 5'),
                                                                                                     'erc20-vault.compact line 169 char 5')]));
  }
  _depositPath_0(recipient_0) {
    return this._persistentHash_0([new Uint8Array([118, 97, 117, 108, 116, 58, 100, 101, 112, 111, 115, 105, 116, 45, 112, 97, 116, 104, 58, 118, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                   recipient_0.is_left,
                                   recipient_0.left.bytes,
                                   recipient_0.right.bytes]);
  }
  _vaultPath_0() {
    return new Uint8Array([118, 97, 117, 108, 116, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  _initialiseDigest_0(vaultAddress_0, vaultEvm_0, chainId_0, responseKey_0) {
    return this._persistentHash_1([new Uint8Array([118, 97, 117, 108, 116, 58, 105, 110, 105, 116, 105, 97, 108, 105, 115, 101, 58, 118, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                   vaultAddress_0,
                                   vaultEvm_0,
                                   chainId_0,
                                   responseKey_0]);
  }
  async _assertAttestedFailureOutput_0(context,
                                       partialProofData,
                                       disclosedRequestId_0,
                                       respondBidirectionalEvent_0,
                                       serializedOutput_0)
  {
    let t_0;
    __compactRuntime.assert((t_0 = _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                             partialProofData,
                                                                                             [
                                                                                              { dup: { n: 0 } },
                                                                                              { idx: { cached: false,
                                                                                                       pushPath: false,
                                                                                                       path: [
                                                                                                              { tag: 'value',
                                                                                                                value: { value: _descriptor_4.toValue(7n),
                                                                                                                         alignment: _descriptor_4.alignment() } }] } },
                                                                                              { popeq: { cached: true,
                                                                                                         result: undefined } }]).value),
                             t_0 >= 1n),
                            'Not initialised');
    __compactRuntime.assert(this._verifyRespondBidirectionalEvent_1(disclosedRequestId_0,
                                                                    serializedOutput_0,
                                                                    respondBidirectionalEvent_0,
                                                                    _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                              partialProofData,
                                                                                                                              [
                                                                                                                               { dup: { n: 0 } },
                                                                                                                               { idx: { cached: false,
                                                                                                                                        pushPath: false,
                                                                                                                                        path: [
                                                                                                                                               { tag: 'value',
                                                                                                                                                 value: { value: _descriptor_4.toValue(5n),
                                                                                                                                                          alignment: _descriptor_4.alignment() } }] } },
                                                                                                                               { popeq: { cached: false,
                                                                                                                                          result: undefined } }]).value)),
                            'Invalid attestation signature');
    const failureOutput_0 = Uint8Array.from([222n, 173n, 190n, 239n, 1n], Number);
    __compactRuntime.assert(this._equal_1(serializedOutput_0, failureOutput_0),
                            'Not the MPC failure output');
    return [];
  }
  async _initialise_0(context,
                      partialProofData,
                      vaultEvm_0,
                      chainId_0,
                      responseKey_0,
                      deployerSignature_0)
  {
    __compactRuntime.assert(_descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(7n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value)
                            ===
                            0n,
                            'Already initialised');
    __compactRuntime.assert(chainId_0 > 0n, 'Chain ID must be positive');
    __compactRuntime.assert(__compactRuntime.convertBytesToUint(52435875175126190479447740508185965837690552500527637822603658699938581184512n,
                                                                20,
                                                                vaultEvm_0,
                                                                'Field',
                                                                'erc20-vault.compact line 269 char 10')
                            !==
                            0n,
                            'Vault EVM address cannot be zero');
    const digest_0 = this._initialiseDigest_0(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                        partialProofData,
                                                                                                        [
                                                                                                         { dup: { n: 2 } },
                                                                                                         { idx: { cached: true,
                                                                                                                  pushPath: false,
                                                                                                                  path: [
                                                                                                                         { tag: 'value',
                                                                                                                           value: { value: _descriptor_4.toValue(0n),
                                                                                                                                    alignment: _descriptor_4.alignment() } }] } },
                                                                                                         { popeq: { cached: true,
                                                                                                                    result: undefined } }]).value),
                                              vaultEvm_0,
                                              chainId_0,
                                              responseKey_0);
    __compactRuntime.assert(this._secp256k1EcdsaVerify_0(digest_0,
                                                         deployerSignature_0,
                                                         _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                   partialProofData,
                                                                                                                   [
                                                                                                                    { dup: { n: 0 } },
                                                                                                                    { idx: { cached: false,
                                                                                                                             pushPath: false,
                                                                                                                             path: [
                                                                                                                                    { tag: 'value',
                                                                                                                                      value: { value: _descriptor_4.toValue(10n),
                                                                                                                                               alignment: _descriptor_4.alignment() } }] } },
                                                                                                                    { popeq: { cached: false,
                                                                                                                               result: undefined } }]).value)),
                            'Not the deployer');
    const tmp_0 = 1n;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(7n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { addi: { immediate: parseInt(__compactRuntime.valueToBigInt(
                                                              { value: _descriptor_18.toValue(tmp_0),
                                                                alignment: _descriptor_18.alignment() }
                                                                .value
                                                            )) } },
                                       { ins: { cached: true, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(8n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(vaultEvm_0),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(9n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(chainId_0),
                                                                                              alignment: _descriptor_5.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(5n),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(responseKey_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    return [];
  }
  async _startDeposit_0(context,
                        partialProofData,
                        evmNonce_0,
                        gasLimit_0,
                        maxFeePerGas_0,
                        maxPriorityFeePerGas_0,
                        keyVersion_0,
                        erc20Address_0,
                        amount_0,
                        recipient_0)
  {
    let t_0;
    __compactRuntime.assert((t_0 = _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                             partialProofData,
                                                                                             [
                                                                                              { dup: { n: 0 } },
                                                                                              { idx: { cached: false,
                                                                                                       pushPath: false,
                                                                                                       path: [
                                                                                                              { tag: 'value',
                                                                                                                value: { value: _descriptor_4.toValue(7n),
                                                                                                                         alignment: _descriptor_4.alignment() } }] } },
                                                                                              { popeq: { cached: true,
                                                                                                         result: undefined } }]).value),
                             t_0 >= 1n),
                            'Not initialised');
    __compactRuntime.assert(__compactRuntime.convertBytesToUint(52435875175126190479447740508185965837690552500527637822603658699938581184512n,
                                                                20,
                                                                erc20Address_0,
                                                                'Field',
                                                                'erc20-vault.compact line 299 char 10')
                            !==
                            0n,
                            'ERC20 address cannot be zero');
    __compactRuntime.assert(amount_0 > 0n, 'Amount must be positive');
    __compactRuntime.assert(amount_0 <= 18446744073709551615n,
                            'Amount exceeds Uint<64> max');
    __compactRuntime.assert(gasLimit_0 > 0n, 'Gas limit must be positive');
    const mintRecipient_0 = recipient_0;
    const path_0 = this._depositPath_0(mintRecipient_0);
    const calldata_0 = { selector:
                           Uint8Array.from([169n, 5n, 156n, 187n], Number),
                         noWords: 2n,
                         words:
                           [this._evmAddressAbiWord_0(_descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                partialProofData,
                                                                                                                [
                                                                                                                 { dup: { n: 0 } },
                                                                                                                 { idx: { cached: false,
                                                                                                                          pushPath: false,
                                                                                                                          path: [
                                                                                                                                 { tag: 'value',
                                                                                                                                   value: { value: _descriptor_4.toValue(8n),
                                                                                                                                            alignment: _descriptor_4.alignment() } }] } },
                                                                                                                 { popeq: { cached: false,
                                                                                                                            result: undefined } }]).value)),
                            this._numericAbiWord_0(amount_0)] };
    const txParams_0 = { chainId:
                           _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                     partialProofData,
                                                                                     [
                                                                                      { dup: { n: 0 } },
                                                                                      { idx: { cached: false,
                                                                                               pushPath: false,
                                                                                               path: [
                                                                                                      { tag: 'value',
                                                                                                        value: { value: _descriptor_4.toValue(9n),
                                                                                                                 alignment: _descriptor_4.alignment() } }] } },
                                                                                      { popeq: { cached: false,
                                                                                                 result: undefined } }]).value),
                         nonce: evmNonce_0,
                         maxPriorityFeePerGas: maxPriorityFeePerGas_0,
                         maxFeePerGas: maxFeePerGas_0,
                         gasLimit: gasLimit_0,
                         to: erc20Address_0,
                         value: 0n,
                         calldata: this._some_0(calldata_0),
                         accessListEntryCount: 0n,
                         accessList: [] };
    const schema_0 = this._vaultResponseSchema_0();
    const requestNonce_0 = _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                     partialProofData,
                                                                                     [
                                                                                      { dup: { n: 0 } },
                                                                                      { idx: { cached: false,
                                                                                               pushPath: false,
                                                                                               path: [
                                                                                                      { tag: 'value',
                                                                                                        value: { value: _descriptor_4.toValue(6n),
                                                                                                                 alignment: _descriptor_4.alignment() } }] } },
                                                                                      { popeq: { cached: true,
                                                                                                 result: undefined } }]).value);
    const request_0 = this._constructSignBidirectionalEvent_0(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                        partialProofData,
                                                                                                                        [
                                                                                                                         { dup: { n: 2 } },
                                                                                                                         { idx: { cached: true,
                                                                                                                                  pushPath: false,
                                                                                                                                  path: [
                                                                                                                                         { tag: 'value',
                                                                                                                                           value: { value: _descriptor_4.toValue(0n),
                                                                                                                                                    alignment: _descriptor_4.alignment() } }] } },
                                                                                                                         { popeq: { cached: true,
                                                                                                                                    result: undefined } }]).value),
                                                              requestNonce_0,
                                                              keyVersion_0,
                                                              path_0,
                                                              0,
                                                              0,
                                                              new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                                              0,
                                                              txParams_0,
                                                              this._ethereumCaip2Id_0(),
                                                              schema_0,
                                                              schema_0);
    const requestId_0 = this._calculateRequestId_0(request_0);
    __compactRuntime.assert(!_descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                       partialProofData,
                                                                                       [
                                                                                        { dup: { n: 0 } },
                                                                                        { idx: { cached: false,
                                                                                                 pushPath: false,
                                                                                                 path: [
                                                                                                        { tag: 'value',
                                                                                                          value: { value: _descriptor_4.toValue(0n),
                                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                                        { push: { storage: false,
                                                                                                  value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(requestId_0),
                                                                                                                                               alignment: _descriptor_1.alignment() }).encode() } },
                                                                                        'member',
                                                                                        { popeq: { cached: true,
                                                                                                   result: undefined } }]).value),
                            'Request already exists');
    const tmp_0 = 1n;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(6n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { addi: { immediate: parseInt(__compactRuntime.valueToBigInt(
                                                              { value: _descriptor_18.toValue(tmp_0),
                                                                alignment: _descriptor_18.alignment() }
                                                                .value
                                                            )) } },
                                       { ins: { cached: true, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(0n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(requestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_27.toValue(request_0),
                                                                                              alignment: _descriptor_27.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    const tmp_1 = { recipient: mintRecipient_0,
                    erc20: erc20Address_0,
                    amount:
                      ((t1) => {
                        if (t1 > 18446744073709551615n) {
                          throw new __compactRuntime.CompactError('erc20-vault.compact line 355 char 22: cast from Field or Uint value to smaller Uint value failed: ' + t1 + ' is greater than 18446744073709551615');
                        }
                        return t1;
                      })(amount_0) };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(1n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(requestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_35.toValue(tmp_1),
                                                                                              alignment: _descriptor_35.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    await __compactRuntime.crossContractCall(context,
                                             __compactContractsImport_SignetSigner,
                                             'signBidirectional',
                                             __compactRuntime.decodeContractAddress((_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                                               partialProofData,
                                                                                                                                               [
                                                                                                                                                { dup: { n: 0 } },
                                                                                                                                                { idx: { cached: false,
                                                                                                                                                         pushPath: false,
                                                                                                                                                         path: [
                                                                                                                                                                { tag: 'value',
                                                                                                                                                                  value: { value: _descriptor_4.toValue(4n),
                                                                                                                                                                           alignment: _descriptor_4.alignment() } }] } },
                                                                                                                                                { popeq: { cached: false,
                                                                                                                                                           result: undefined } }]).value)).bytes),
                                             false,
                                             partialProofData,
                                             requestId_0,
                                             this._constructSignBidirectionalEventNotificationV1_0(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                                                             partialProofData,
                                                                                                                                                             [
                                                                                                                                                              { dup: { n: 2 } },
                                                                                                                                                              { idx: { cached: true,
                                                                                                                                                                       pushPath: false,
                                                                                                                                                                       path: [
                                                                                                                                                                              { tag: 'value',
                                                                                                                                                                                value: { value: _descriptor_4.toValue(0n),
                                                                                                                                                                                         alignment: _descriptor_4.alignment() } }] } },
                                                                                                                                                              { popeq: { cached: true,
                                                                                                                                                                         result: undefined } }]).value),
                                                                                                   1n,
                                                                                                   [0n,
                                                                                                    0n,
                                                                                                    0n,
                                                                                                    0n]));
    return [];
  }
  async _completeDeposit_0(context,
                           partialProofData,
                           requestId_0,
                           respondBidirectionalEvent_0,
                           serializedOutput_0,
                           mintNonce_0)
  {
    const disclosedRequestId_0 = requestId_0;
    let t_0;
    __compactRuntime.assert((t_0 = _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                             partialProofData,
                                                                                             [
                                                                                              { dup: { n: 0 } },
                                                                                              { idx: { cached: false,
                                                                                                       pushPath: false,
                                                                                                       path: [
                                                                                                              { tag: 'value',
                                                                                                                value: { value: _descriptor_4.toValue(7n),
                                                                                                                         alignment: _descriptor_4.alignment() } }] } },
                                                                                              { popeq: { cached: true,
                                                                                                         result: undefined } }]).value),
                             t_0 >= 1n),
                            'Not initialised');
    __compactRuntime.assert(this._verifyRespondBidirectionalEvent_0(disclosedRequestId_0,
                                                                    serializedOutput_0,
                                                                    respondBidirectionalEvent_0,
                                                                    _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                              partialProofData,
                                                                                                                              [
                                                                                                                               { dup: { n: 0 } },
                                                                                                                               { idx: { cached: false,
                                                                                                                                        pushPath: false,
                                                                                                                                        path: [
                                                                                                                                               { tag: 'value',
                                                                                                                                                 value: { value: _descriptor_4.toValue(5n),
                                                                                                                                                          alignment: _descriptor_4.alignment() } }] } },
                                                                                                                               { popeq: { cached: false,
                                                                                                                                          result: undefined } }]).value)),
                            'Invalid attestation signature');
    __compactRuntime.assert(_descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(0n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'Deposit not found');
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(0n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    const view_0 = _descriptor_35.fromValue(__compactRuntime.queryLedgerState(context,
                                                                              partialProofData,
                                                                              [
                                                                               { dup: { n: 0 } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_4.toValue(1n),
                                                                                                          alignment: _descriptor_4.alignment() } }] } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                                          alignment: _descriptor_1.alignment() } }] } },
                                                                               { popeq: { cached: false,
                                                                                          result: undefined } }]).value);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(1n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    const succeeded_0 = this._deserialize_0(serializedOutput_0).success;
    if (succeeded_0) {
      return this._some_1(await this._mintShieldedToken_0(context,
                                                          partialProofData,
                                                          this._vaultTokenDomainSeparator_0(view_0.erc20),
                                                          view_0.amount,
                                                          mintNonce_0,
                                                          view_0.recipient));
    } else {
      return this._none_0();
    }
  }
  async _abandonDeposit_0(context,
                          partialProofData,
                          requestId_0,
                          respondBidirectionalEvent_0,
                          serializedOutput_0)
  {
    const disclosedRequestId_0 = requestId_0;
    await this._assertAttestedFailureOutput_0(context,
                                              partialProofData,
                                              disclosedRequestId_0,
                                              respondBidirectionalEvent_0,
                                              serializedOutput_0);
    __compactRuntime.assert(_descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(0n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'Deposit not found');
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(0n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(1n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  async _startWithdraw_0(context,
                         partialProofData,
                         evmNonce_0,
                         gasLimit_0,
                         maxFeePerGas_0,
                         maxPriorityFeePerGas_0,
                         keyVersion_0,
                         erc20Address_0,
                         amount_0,
                         destEvmAddress_0,
                         coin_0,
                         refundRecipient_0)
  {
    let t_0;
    __compactRuntime.assert((t_0 = _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                             partialProofData,
                                                                                             [
                                                                                              { dup: { n: 0 } },
                                                                                              { idx: { cached: false,
                                                                                                       pushPath: false,
                                                                                                       path: [
                                                                                                              { tag: 'value',
                                                                                                                value: { value: _descriptor_4.toValue(7n),
                                                                                                                         alignment: _descriptor_4.alignment() } }] } },
                                                                                              { popeq: { cached: true,
                                                                                                         result: undefined } }]).value),
                             t_0 >= 1n),
                            'Not initialised');
    __compactRuntime.assert(__compactRuntime.convertBytesToUint(52435875175126190479447740508185965837690552500527637822603658699938581184512n,
                                                                20,
                                                                erc20Address_0,
                                                                'Field',
                                                                'erc20-vault.compact line 467 char 10')
                            !==
                            0n,
                            'ERC20 address cannot be zero');
    __compactRuntime.assert(__compactRuntime.convertBytesToUint(52435875175126190479447740508185965837690552500527637822603658699938581184512n,
                                                                20,
                                                                destEvmAddress_0,
                                                                'Field',
                                                                'erc20-vault.compact line 468 char 10')
                            !==
                            0n,
                            'Destination address cannot be zero');
    __compactRuntime.assert(amount_0 > 0n, 'Amount must be positive');
    __compactRuntime.assert(amount_0 <= 18446744073709551615n,
                            'Amount exceeds Uint<64> max');
    __compactRuntime.assert(gasLimit_0 > 0n, 'Gas limit must be positive');
    const color_0 = this._tokenType_0(this._vaultTokenDomainSeparator_0(erc20Address_0),
                                      _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                partialProofData,
                                                                                                [
                                                                                                 { dup: { n: 2 } },
                                                                                                 { idx: { cached: true,
                                                                                                          pushPath: false,
                                                                                                          path: [
                                                                                                                 { tag: 'value',
                                                                                                                   value: { value: _descriptor_4.toValue(0n),
                                                                                                                            alignment: _descriptor_4.alignment() } }] } },
                                                                                                 { popeq: { cached: true,
                                                                                                            result: undefined } }]).value));
    __compactRuntime.assert(this._equal_2(coin_0.color, color_0),
                            'Coin is not the vault token for this ERC20');
    __compactRuntime.assert(coin_0.value === amount_0,
                            'Coin value must equal the withdraw amount');
    const calldata_0 = { selector:
                           Uint8Array.from([169n, 5n, 156n, 187n], Number),
                         noWords: 2n,
                         words:
                           [this._evmAddressAbiWord_0(destEvmAddress_0),
                            this._numericAbiWord_0(amount_0)] };
    const txParams_0 = { chainId:
                           _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                     partialProofData,
                                                                                     [
                                                                                      { dup: { n: 0 } },
                                                                                      { idx: { cached: false,
                                                                                               pushPath: false,
                                                                                               path: [
                                                                                                      { tag: 'value',
                                                                                                        value: { value: _descriptor_4.toValue(9n),
                                                                                                                 alignment: _descriptor_4.alignment() } }] } },
                                                                                      { popeq: { cached: false,
                                                                                                 result: undefined } }]).value),
                         nonce: evmNonce_0,
                         maxPriorityFeePerGas: maxPriorityFeePerGas_0,
                         maxFeePerGas: maxFeePerGas_0,
                         gasLimit: gasLimit_0,
                         to: erc20Address_0,
                         value: 0n,
                         calldata: this._some_0(calldata_0),
                         accessListEntryCount: 0n,
                         accessList: [] };
    const schema_0 = this._vaultResponseSchema_0();
    const requestNonce_0 = _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                     partialProofData,
                                                                                     [
                                                                                      { dup: { n: 0 } },
                                                                                      { idx: { cached: false,
                                                                                               pushPath: false,
                                                                                               path: [
                                                                                                      { tag: 'value',
                                                                                                        value: { value: _descriptor_4.toValue(6n),
                                                                                                                 alignment: _descriptor_4.alignment() } }] } },
                                                                                      { popeq: { cached: true,
                                                                                                 result: undefined } }]).value);
    const request_0 = this._constructSignBidirectionalEvent_0(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                        partialProofData,
                                                                                                                        [
                                                                                                                         { dup: { n: 2 } },
                                                                                                                         { idx: { cached: true,
                                                                                                                                  pushPath: false,
                                                                                                                                  path: [
                                                                                                                                         { tag: 'value',
                                                                                                                                           value: { value: _descriptor_4.toValue(0n),
                                                                                                                                                    alignment: _descriptor_4.alignment() } }] } },
                                                                                                                         { popeq: { cached: true,
                                                                                                                                    result: undefined } }]).value),
                                                              requestNonce_0,
                                                              keyVersion_0,
                                                              this._vaultPath_0(),
                                                              0,
                                                              0,
                                                              new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                                              0,
                                                              txParams_0,
                                                              this._ethereumCaip2Id_0(),
                                                              schema_0,
                                                              schema_0);
    const requestId_0 = this._calculateRequestId_0(request_0);
    __compactRuntime.assert(!_descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                       partialProofData,
                                                                                       [
                                                                                        { dup: { n: 0 } },
                                                                                        { idx: { cached: false,
                                                                                                 pushPath: false,
                                                                                                 path: [
                                                                                                        { tag: 'value',
                                                                                                          value: { value: _descriptor_4.toValue(2n),
                                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                                        { push: { storage: false,
                                                                                                  value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(requestId_0),
                                                                                                                                               alignment: _descriptor_1.alignment() }).encode() } },
                                                                                        'member',
                                                                                        { popeq: { cached: true,
                                                                                                   result: undefined } }]).value),
                            'Request already exists');
    await this._receiveShielded_0(context, partialProofData, coin_0);
    const tmp_0 = 1n;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(6n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { addi: { immediate: parseInt(__compactRuntime.valueToBigInt(
                                                              { value: _descriptor_18.toValue(tmp_0),
                                                                alignment: _descriptor_18.alignment() }
                                                                .value
                                                            )) } },
                                       { ins: { cached: true, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(2n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(requestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_27.toValue(request_0),
                                                                                              alignment: _descriptor_27.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    const tmp_1 = { refundRecipient: refundRecipient_0,
                    erc20: erc20Address_0,
                    amount:
                      ((t1) => {
                        if (t1 > 18446744073709551615n) {
                          throw new __compactRuntime.CompactError('erc20-vault.compact line 530 char 22: cast from Field or Uint value to smaller Uint value failed: ' + t1 + ' is greater than 18446744073709551615');
                        }
                        return t1;
                      })(amount_0) };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(3n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(requestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_11.toValue(tmp_1),
                                                                                              alignment: _descriptor_11.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    await __compactRuntime.crossContractCall(context,
                                             __compactContractsImport_SignetSigner,
                                             'signBidirectional',
                                             __compactRuntime.decodeContractAddress((_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                                               partialProofData,
                                                                                                                                               [
                                                                                                                                                { dup: { n: 0 } },
                                                                                                                                                { idx: { cached: false,
                                                                                                                                                         pushPath: false,
                                                                                                                                                         path: [
                                                                                                                                                                { tag: 'value',
                                                                                                                                                                  value: { value: _descriptor_4.toValue(4n),
                                                                                                                                                                           alignment: _descriptor_4.alignment() } }] } },
                                                                                                                                                { popeq: { cached: false,
                                                                                                                                                           result: undefined } }]).value)).bytes),
                                             false,
                                             partialProofData,
                                             requestId_0,
                                             this._constructSignBidirectionalEventNotificationV1_0(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                                                             partialProofData,
                                                                                                                                                             [
                                                                                                                                                              { dup: { n: 2 } },
                                                                                                                                                              { idx: { cached: true,
                                                                                                                                                                       pushPath: false,
                                                                                                                                                                       path: [
                                                                                                                                                                              { tag: 'value',
                                                                                                                                                                                value: { value: _descriptor_4.toValue(0n),
                                                                                                                                                                                         alignment: _descriptor_4.alignment() } }] } },
                                                                                                                                                              { popeq: { cached: true,
                                                                                                                                                                         result: undefined } }]).value),
                                                                                                   1n,
                                                                                                   [2n,
                                                                                                    0n,
                                                                                                    0n,
                                                                                                    0n]));
    return [];
  }
  async _completeWithdraw_0(context,
                            partialProofData,
                            requestId_0,
                            respondBidirectionalEvent_0,
                            serializedOutput_0,
                            mintNonce_0)
  {
    const disclosedRequestId_0 = requestId_0;
    let t_0;
    __compactRuntime.assert((t_0 = _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                             partialProofData,
                                                                                             [
                                                                                              { dup: { n: 0 } },
                                                                                              { idx: { cached: false,
                                                                                                       pushPath: false,
                                                                                                       path: [
                                                                                                              { tag: 'value',
                                                                                                                value: { value: _descriptor_4.toValue(7n),
                                                                                                                         alignment: _descriptor_4.alignment() } }] } },
                                                                                              { popeq: { cached: true,
                                                                                                         result: undefined } }]).value),
                             t_0 >= 1n),
                            'Not initialised');
    __compactRuntime.assert(this._verifyRespondBidirectionalEvent_0(disclosedRequestId_0,
                                                                    serializedOutput_0,
                                                                    respondBidirectionalEvent_0,
                                                                    _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                              partialProofData,
                                                                                                                              [
                                                                                                                               { dup: { n: 0 } },
                                                                                                                               { idx: { cached: false,
                                                                                                                                        pushPath: false,
                                                                                                                                        path: [
                                                                                                                                               { tag: 'value',
                                                                                                                                                 value: { value: _descriptor_4.toValue(5n),
                                                                                                                                                          alignment: _descriptor_4.alignment() } }] } },
                                                                                                                               { popeq: { cached: false,
                                                                                                                                          result: undefined } }]).value)),
                            'Invalid attestation signature');
    __compactRuntime.assert(_descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(3n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'Withdrawal not found');
    const view_0 = _descriptor_11.fromValue(__compactRuntime.queryLedgerState(context,
                                                                              partialProofData,
                                                                              [
                                                                               { dup: { n: 0 } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_4.toValue(3n),
                                                                                                          alignment: _descriptor_4.alignment() } }] } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                                          alignment: _descriptor_1.alignment() } }] } },
                                                                               { popeq: { cached: false,
                                                                                          result: undefined } }]).value);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(2n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(3n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    const succeeded_0 = this._deserialize_0(serializedOutput_0).success;
    if (!succeeded_0) {
      return this._some_1(await this._mintShieldedToken_0(context,
                                                          partialProofData,
                                                          this._vaultTokenDomainSeparator_0(view_0.erc20),
                                                          view_0.amount,
                                                          mintNonce_0,
                                                          view_0.refundRecipient));
    } else {
      return this._none_0();
    }
  }
  async _refundWithdraw_0(context,
                          partialProofData,
                          requestId_0,
                          respondBidirectionalEvent_0,
                          serializedOutput_0,
                          mintNonce_0)
  {
    const disclosedRequestId_0 = requestId_0;
    await this._assertAttestedFailureOutput_0(context,
                                              partialProofData,
                                              disclosedRequestId_0,
                                              respondBidirectionalEvent_0,
                                              serializedOutput_0);
    __compactRuntime.assert(_descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                      partialProofData,
                                                                                      [
                                                                                       { dup: { n: 0 } },
                                                                                       { idx: { cached: false,
                                                                                                pushPath: false,
                                                                                                path: [
                                                                                                       { tag: 'value',
                                                                                                         value: { value: _descriptor_4.toValue(3n),
                                                                                                                  alignment: _descriptor_4.alignment() } }] } },
                                                                                       { push: { storage: false,
                                                                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                                                                       'member',
                                                                                       { popeq: { cached: true,
                                                                                                  result: undefined } }]).value),
                            'Withdrawal not found');
    const view_0 = _descriptor_11.fromValue(__compactRuntime.queryLedgerState(context,
                                                                              partialProofData,
                                                                              [
                                                                               { dup: { n: 0 } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_4.toValue(3n),
                                                                                                          alignment: _descriptor_4.alignment() } }] } },
                                                                               { idx: { cached: false,
                                                                                        pushPath: false,
                                                                                        path: [
                                                                                               { tag: 'value',
                                                                                                 value: { value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                                          alignment: _descriptor_1.alignment() } }] } },
                                                                               { popeq: { cached: false,
                                                                                          result: undefined } }]).value);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(2n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_4.toValue(3n),
                                                                  alignment: _descriptor_4.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(disclosedRequestId_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { rem: { cached: false } },
                                       { ins: { cached: true, n: 1 } }]);
    return await this._mintShieldedToken_0(context,
                                           partialProofData,
                                           this._vaultTokenDomainSeparator_0(view_0.erc20),
                                           view_0.amount,
                                           mintNonce_0,
                                           view_0.refundRecipient);
  }
  _tokenMetadataDigest_0(vaultAddress_0,
                         erc20Address_0,
                         name_0,
                         nameLen_0,
                         symbol_0,
                         symbolLen_0,
                         decimals_0,
                         validUntil_0)
  {
    return this._persistentHash_3([new Uint8Array([118, 97, 117, 108, 116, 58, 116, 111, 107, 101, 110, 45, 109, 101, 116, 97, 100, 97, 116, 97, 58, 118, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                   vaultAddress_0,
                                   erc20Address_0,
                                   name_0,
                                   nameLen_0,
                                   symbol_0,
                                   symbolLen_0,
                                   decimals_0,
                                   validUntil_0]);
  }
  async _publishTokenMetadata_0(context,
                                partialProofData,
                                erc20Address_0,
                                name_0,
                                nameLen_0,
                                symbol_0,
                                symbolLen_0,
                                decimals_0,
                                validUntil_0,
                                adminSignature_0)
  {
    __compactRuntime.assert(nameLen_0 <= 32n, 'Name longer than 32 bytes');
    __compactRuntime.assert(symbolLen_0 <= 32n, 'Symbol longer than 32 bytes');
    __compactRuntime.assert(await this._blockTimeLt_0(context,
                                                      partialProofData,
                                                      validUntil_0),
                            'Metadata signature expired');
    const digest_0 = this._tokenMetadataDigest_0(_descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                           partialProofData,
                                                                                                           [
                                                                                                            { dup: { n: 2 } },
                                                                                                            { idx: { cached: true,
                                                                                                                     pushPath: false,
                                                                                                                     path: [
                                                                                                                            { tag: 'value',
                                                                                                                              value: { value: _descriptor_4.toValue(0n),
                                                                                                                                       alignment: _descriptor_4.alignment() } }] } },
                                                                                                            { popeq: { cached: true,
                                                                                                                       result: undefined } }]).value),
                                                 erc20Address_0,
                                                 name_0,
                                                 nameLen_0,
                                                 symbol_0,
                                                 symbolLen_0,
                                                 decimals_0,
                                                 validUntil_0);
    __compactRuntime.assert(this._secp256k1EcdsaVerify_0(digest_0,
                                                         adminSignature_0,
                                                         _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                   partialProofData,
                                                                                                                   [
                                                                                                                    { dup: { n: 0 } },
                                                                                                                    { idx: { cached: false,
                                                                                                                             pushPath: false,
                                                                                                                             path: [
                                                                                                                                    { tag: 'value',
                                                                                                                                      value: { value: _descriptor_4.toValue(10n),
                                                                                                                                               alignment: _descriptor_4.alignment() } }] } },
                                                                                                                    { popeq: { cached: false,
                                                                                                                               result: undefined } }]).value)),
                            'Not the vault admin');
    await this._emitStandardFields_0(context,
                                     partialProofData,
                                     this._vaultTokenDomainSeparator_0(erc20Address_0),
                                     this._KIND_SHIELDED_0(),
                                     name_0,
                                     nameLen_0,
                                     symbol_0,
                                     symbolLen_0,
                                     decimals_0);
    return [];
  }
  _equal_0(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_1(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_2(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
}
export function ledger(stateOrChargedState) {
  const state = stateOrChargedState instanceof __compactRuntime.StateValue ? stateOrChargedState : stateOrChargedState.state;
  const chargedState = stateOrChargedState instanceof __compactRuntime.StateValue ? new __compactRuntime.ChargedState(stateOrChargedState) : stateOrChargedState;
  const context = {
    callContext: { currentQueryContext: new __compactRuntime.QueryContext(chargedState, __compactRuntime.dummyContractAddress()), currentGasCost: __compactRuntime.emptyRunningCost() },
    costModel: __compactRuntime.CostModel.initialCostModel()
  };
  const partialProofData = {
    input: { value: [], alignment: [] },
    output: undefined,
    publicTranscript: [],
    privateTranscriptOutputs: []
  };
  return {
    depositEventMap: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(0n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(0n),
                                                                                                                                 alignment: _descriptor_5.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(0n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'erc20-vault.compact line 88 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(0n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(key_0),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'erc20-vault.compact line 88 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_27.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_4.toValue(0n),
                                                                                                      alignment: _descriptor_4.alignment() } }] } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_1.toValue(key_0),
                                                                                                      alignment: _descriptor_1.alignment() } }] } },
                                                                           { popeq: { cached: false,
                                                                                      result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[0];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_1.fromValue(key.value),      _descriptor_27.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    depositSettleViews: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(1n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(0n),
                                                                                                                                 alignment: _descriptor_5.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(1n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'erc20-vault.compact line 100 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(1n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(key_0),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'erc20-vault.compact line 100 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_35.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_4.toValue(1n),
                                                                                                      alignment: _descriptor_4.alignment() } }] } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_1.toValue(key_0),
                                                                                                      alignment: _descriptor_1.alignment() } }] } },
                                                                           { popeq: { cached: false,
                                                                                      result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[1];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_1.fromValue(key.value),      _descriptor_35.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    withdrawEventMap: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(2n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(0n),
                                                                                                                                 alignment: _descriptor_5.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(2n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'erc20-vault.compact line 103 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(2n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(key_0),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'erc20-vault.compact line 103 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_27.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_4.toValue(2n),
                                                                                                      alignment: _descriptor_4.alignment() } }] } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_1.toValue(key_0),
                                                                                                      alignment: _descriptor_1.alignment() } }] } },
                                                                           { popeq: { cached: false,
                                                                                      result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[2];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_1.fromValue(key.value),      _descriptor_27.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    withdrawSettleViews: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(3n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_5.toValue(0n),
                                                                                                                                 alignment: _descriptor_5.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(3n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'erc20-vault.compact line 120 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_4.toValue(3n),
                                                                                                     alignment: _descriptor_4.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(key_0),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'erc20-vault.compact line 120 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_11.fromValue(__compactRuntime.queryLedgerState(context,
                                                                          partialProofData,
                                                                          [
                                                                           { dup: { n: 0 } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_4.toValue(3n),
                                                                                                      alignment: _descriptor_4.alignment() } }] } },
                                                                           { idx: { cached: false,
                                                                                    pushPath: false,
                                                                                    path: [
                                                                                           { tag: 'value',
                                                                                             value: { value: _descriptor_1.toValue(key_0),
                                                                                                      alignment: _descriptor_1.alignment() } }] } },
                                                                           { popeq: { cached: false,
                                                                                      result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[3];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_1.fromValue(key.value),      _descriptor_11.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    get mpcResponseKey() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_4.toValue(5n),
                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get signetRequestNonce() {
      return _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_4.toValue(6n),
                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                        { popeq: { cached: true,
                                                                                   result: undefined } }]).value);
    },
    get initialised() {
      return _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_4.toValue(7n),
                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                        { popeq: { cached: true,
                                                                                   result: undefined } }]).value);
    },
    get vaultEvmAddress() {
      return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_4.toValue(8n),
                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get evmChainId() {
      return _descriptor_5.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_4.toValue(9n),
                                                                                                   alignment: _descriptor_4.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    }
  };
}
const _emptyContext = {
  callContext: { currentQueryContext: new __compactRuntime.QueryContext(new __compactRuntime.ContractState().data, __compactRuntime.dummyContractAddress()), currentGasCost: __compactRuntime.emptyRunningCost() }
};
const _dummyContract = new Contract({ });
export const pureCircuits = {
  vaultResponseSchema: (...args_0) => {
    if (args_0.length !== 0) {
      throw new __compactRuntime.CompactError(`vaultResponseSchema: expected 0 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    return _dummyContract._vaultResponseSchema_0();
  },
  vaultTokenDomainSeparator: (...args_0) => {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`vaultTokenDomainSeparator: expected 1 argument (as invoked from Typescript), received ${args_0.length}`);
    }
    const erc20Address_0 = args_0[0];
    if (!(erc20Address_0.buffer instanceof ArrayBuffer && erc20Address_0.BYTES_PER_ELEMENT === 1 && erc20Address_0.length === 20)) {
      __compactRuntime.typeError('vaultTokenDomainSeparator',
                                 'argument 1',
                                 'erc20-vault.compact line 166 char 1',
                                 'Bytes<20>',
                                 erc20Address_0)
    }
    return _dummyContract._vaultTokenDomainSeparator_0(erc20Address_0);
  },
  depositPath: (...args_0) => {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`depositPath: expected 1 argument (as invoked from Typescript), received ${args_0.length}`);
    }
    const recipient_0 = args_0[0];
    if (!(typeof(recipient_0) === 'object' && typeof(recipient_0.is_left) === 'boolean' && typeof(recipient_0.left) === 'object' && recipient_0.left.bytes.buffer instanceof ArrayBuffer && recipient_0.left.bytes.BYTES_PER_ELEMENT === 1 && recipient_0.left.bytes.length === 32 && typeof(recipient_0.right) === 'object' && recipient_0.right.bytes.buffer instanceof ArrayBuffer && recipient_0.right.bytes.BYTES_PER_ELEMENT === 1 && recipient_0.right.bytes.length === 32)) {
      __compactRuntime.typeError('depositPath',
                                 'argument 1',
                                 'erc20-vault.compact line 185 char 1',
                                 'struct Either<is_left: Boolean, left: struct ZswapCoinPublicKey<bytes: Bytes<32>>, right: struct ContractAddress<bytes: Bytes<32>>>',
                                 recipient_0)
    }
    return _dummyContract._depositPath_0(recipient_0);
  },
  vaultPath: (...args_0) => {
    if (args_0.length !== 0) {
      throw new __compactRuntime.CompactError(`vaultPath: expected 0 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    return _dummyContract._vaultPath_0();
  },
  initialiseDigest: (...args_0) => {
    if (args_0.length !== 4) {
      throw new __compactRuntime.CompactError(`initialiseDigest: expected 4 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const vaultAddress_0 = args_0[0];
    const vaultEvm_0 = args_0[1];
    const chainId_0 = args_0[2];
    const responseKey_0 = args_0[3];
    if (!(typeof(vaultAddress_0) === 'object' && vaultAddress_0.bytes.buffer instanceof ArrayBuffer && vaultAddress_0.bytes.BYTES_PER_ELEMENT === 1 && vaultAddress_0.bytes.length === 32)) {
      __compactRuntime.typeError('initialiseDigest',
                                 'argument 1',
                                 'erc20-vault.compact line 205 char 1',
                                 'struct ContractAddress<bytes: Bytes<32>>',
                                 vaultAddress_0)
    }
    if (!(vaultEvm_0.buffer instanceof ArrayBuffer && vaultEvm_0.BYTES_PER_ELEMENT === 1 && vaultEvm_0.length === 20)) {
      __compactRuntime.typeError('initialiseDigest',
                                 'argument 2',
                                 'erc20-vault.compact line 205 char 1',
                                 'Bytes<20>',
                                 vaultEvm_0)
    }
    if (!(typeof(chainId_0) === 'bigint' && chainId_0 >= 0n && chainId_0 <= 18446744073709551615n)) {
      __compactRuntime.typeError('initialiseDigest',
                                 'argument 3',
                                 'erc20-vault.compact line 205 char 1',
                                 'Uint<0..18446744073709551616>',
                                 chainId_0)
    }
    if (!(typeof(responseKey_0.x) === 'bigint' && typeof(responseKey_0.y) === 'bigint' && typeof(responseKey_0.identity) == 'boolean')) {
      __compactRuntime.typeError('initialiseDigest',
                                 'argument 4',
                                 'erc20-vault.compact line 205 char 1',
                                 'Secp256k1Point',
                                 responseKey_0)
    }
    return _dummyContract._initialiseDigest_0(vaultAddress_0,
                                              vaultEvm_0,
                                              chainId_0,
                                              responseKey_0);
  },
  tokenMetadataDigest: (...args_0) => {
    if (args_0.length !== 8) {
      throw new __compactRuntime.CompactError(`tokenMetadataDigest: expected 8 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const vaultAddress_0 = args_0[0];
    const erc20Address_0 = args_0[1];
    const name_0 = args_0[2];
    const nameLen_0 = args_0[3];
    const symbol_0 = args_0[4];
    const symbolLen_0 = args_0[5];
    const decimals_0 = args_0[6];
    const validUntil_0 = args_0[7];
    if (!(typeof(vaultAddress_0) === 'object' && vaultAddress_0.bytes.buffer instanceof ArrayBuffer && vaultAddress_0.bytes.BYTES_PER_ELEMENT === 1 && vaultAddress_0.bytes.length === 32)) {
      __compactRuntime.typeError('tokenMetadataDigest',
                                 'argument 1',
                                 'erc20-vault.compact line 630 char 1',
                                 'struct ContractAddress<bytes: Bytes<32>>',
                                 vaultAddress_0)
    }
    if (!(erc20Address_0.buffer instanceof ArrayBuffer && erc20Address_0.BYTES_PER_ELEMENT === 1 && erc20Address_0.length === 20)) {
      __compactRuntime.typeError('tokenMetadataDigest',
                                 'argument 2',
                                 'erc20-vault.compact line 630 char 1',
                                 'Bytes<20>',
                                 erc20Address_0)
    }
    if (!(name_0.buffer instanceof ArrayBuffer && name_0.BYTES_PER_ELEMENT === 1 && name_0.length === 32)) {
      __compactRuntime.typeError('tokenMetadataDigest',
                                 'argument 3',
                                 'erc20-vault.compact line 630 char 1',
                                 'Bytes<32>',
                                 name_0)
    }
    if (!(typeof(nameLen_0) === 'bigint' && nameLen_0 >= 0n && nameLen_0 <= 255n)) {
      __compactRuntime.typeError('tokenMetadataDigest',
                                 'argument 4',
                                 'erc20-vault.compact line 630 char 1',
                                 'Uint<0..256>',
                                 nameLen_0)
    }
    if (!(symbol_0.buffer instanceof ArrayBuffer && symbol_0.BYTES_PER_ELEMENT === 1 && symbol_0.length === 32)) {
      __compactRuntime.typeError('tokenMetadataDigest',
                                 'argument 5',
                                 'erc20-vault.compact line 630 char 1',
                                 'Bytes<32>',
                                 symbol_0)
    }
    if (!(typeof(symbolLen_0) === 'bigint' && symbolLen_0 >= 0n && symbolLen_0 <= 255n)) {
      __compactRuntime.typeError('tokenMetadataDigest',
                                 'argument 6',
                                 'erc20-vault.compact line 630 char 1',
                                 'Uint<0..256>',
                                 symbolLen_0)
    }
    if (!(typeof(decimals_0) === 'bigint' && decimals_0 >= 0n && decimals_0 <= 255n)) {
      __compactRuntime.typeError('tokenMetadataDigest',
                                 'argument 7',
                                 'erc20-vault.compact line 630 char 1',
                                 'Uint<0..256>',
                                 decimals_0)
    }
    if (!(typeof(validUntil_0) === 'bigint' && validUntil_0 >= 0n && validUntil_0 <= 18446744073709551615n)) {
      __compactRuntime.typeError('tokenMetadataDigest',
                                 'argument 8',
                                 'erc20-vault.compact line 630 char 1',
                                 'Uint<0..18446744073709551616>',
                                 validUntil_0)
    }
    return _dummyContract._tokenMetadataDigest_0(vaultAddress_0,
                                                 erc20Address_0,
                                                 name_0,
                                                 nameLen_0,
                                                 symbol_0,
                                                 symbolLen_0,
                                                 decimals_0,
                                                 validUntil_0);
  }
};
export const contractReferenceLocations =
  {
   tag: 'publicLedgerArray',
   indices: {
     4: { 
         tag: 'cell',
         valueType: {
                     tag: 'compactValue',
                     descriptor: _descriptor_2,
                     sparseType: { tag: 'contractAddress' }
                    }
        }
   }
  };
export const expectedVk = {
  'abandonDeposit': 'b50ff3961af1dc904e5e2559a3a93f9a16abde58ea1a8154cd925562bf67a350',
  'completeDeposit': '7a61ca4e09a63e4e7f713a3570f47c64e31c90d9a5301d6f454437550a44c90e',
  'completeWithdraw': '33590f23466f75e046fc293e5f3669dade92797606d698e0ba1670697fc92776',
  'initialise': '177e7feaef12c2f5acfebf711026bb19f4958e0cf45a6ea6261afa172c5a3d07',
  'publishTokenMetadata': 'd75c5f4e4efb5aabec056336b17478d0d5d01ee52071d4d108f2616d837d2b27',
  'refundWithdraw': '03fcc5a2ab10c95080e4d704c7cac2a072de389b0d0b3c8a66771e5775c57869',
  'startDeposit': '92eecf2be3aae82c1771c5a7bd7f4a85e51b3fe11c6377e929b3b6b218094990',
  'startWithdraw': '23c977cec9866eab96e3998d61af39d3812e299ccbcbd3fd9d4102fcc9b2717c',
};

//# sourceMappingURL=index.js.map
