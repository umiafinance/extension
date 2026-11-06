export const formatProof = (proof, requestData, route) => {
  if (proof.signatures.attestorAddress?.toLowerCase() !== route?.witness) {
    throw new Error("Proof witness does not match selected authority");
  }
  let formattedProof = {
    identifier: proof.claim.identifier,
    claimData: proof.claim,
    signatures: [toHexString(proof.signatures.claimSignature)],
    witnesses: [
      {
        id: proof.signatures.attestorAddress,
        url: route.attestorUrl,
      },
    ],
    taskId: null,
    publicData: proof.publicData ?? null,
    providerRequest: requestData,
  };
  return formattedProof;
};

const toHexString = (signatureObject) => {
  if (!signatureObject) {
    return "";
  }
  // Convert an object {0: byte0, 1: byte1, ...} to a hex string
  const hexString = Object.values(signatureObject)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hexString}`;
};
