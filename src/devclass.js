'use strict';

// Windows' device class names, as a person would say them. Device Manager shows
// these headings; the raw names ("Net", "Scsiadapter") only mean something to Windows.

const NAMES = {
  net: 'Network adapters',
  display: 'Display adapters',
  media: 'Sound, video and game controllers',
  audioendpoint: 'Audio inputs and outputs',
  audioprocessingobject: 'Audio effects',
  system: 'System devices',
  usb: 'USB controllers',
  usbdevice: 'USB devices',
  hidclass: 'Human interface devices',
  keyboard: 'Keyboards',
  mouse: 'Mice and pointing devices',
  monitor: 'Monitors',
  bluetooth: 'Bluetooth',
  diskdrive: 'Disk drives',
  cdrom: 'DVD and CD drives',
  volume: 'Volumes',
  volumesnapshot: 'Volume shadow copies',
  scsiadapter: 'Storage controllers',
  hdc: 'IDE and SATA controllers',
  processor: 'Processors',
  computer: 'Computer',
  ports: 'Ports (COM and LPT)',
  printer: 'Printers',
  printqueue: 'Print queues',
  image: 'Cameras and scanners',
  camera: 'Cameras',
  wpd: 'Portable devices',
  battery: 'Batteries',
  biometric: 'Fingerprint and face readers',
  smartcardreader: 'Smart card readers',
  securitydevices: 'Security devices',
  softwaredevice: 'Software devices',
  softwarecomponent: 'Software components',
  firmware: 'Firmware',
  extension: 'Driver extensions',
  mtd: 'Memory technology devices',
  sensor: 'Sensors',
  nettrans: 'Network protocols',
  netservice: 'Network services',
  netclient: 'Network clients',
  unknown: 'Other devices',
};

function nice(className) {
  const raw = String(className || '').trim();
  if (!raw) return 'Other devices';
  return NAMES[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

module.exports = { nice };
