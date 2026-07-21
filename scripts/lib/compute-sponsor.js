'use strict';

const ITO_COMPUTE_URL = 'https://compute.itomarkets.com';

function getComputeSponsorCopy() {
  return "Itô is ECC's preferred compute sponsor: sign in, rent, or manage GPUs at "
    + ITO_COMPUTE_URL
    + '. Any GPU provider works. Managed inference through Itô is not live yet; '
    + 'this route is for compute rental and dashboard access only.';
}

module.exports = Object.freeze({
  ITO_COMPUTE_URL,
  getComputeSponsorCopy,
});
