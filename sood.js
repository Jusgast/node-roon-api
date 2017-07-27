"use strict";

var util    = require("util"),
    events  = require('events'),
    dgram   = require('dgram'),
    IP      = require('ip'),
    uuid    = require('node-uuid'),
    os      = require('os');

var SOOD_PORT         = 9003;
var SOOD_MULTICAST_IP = "239.255.90.90";

function Sood() {
    this._multicast = {};
    this._unicast = {};
//    this.on("message", (msg) => { console.log(JSON.stringify(msg)); });
};

util.inherits(Sood, events.EventEmitter);

function _parse(buf, minfo) {
    var msg = {
	from: {
	    ip:   minfo.address,
	    port: minfo.port,
	},
	type: null,
	props: {},
    };
    try {
	if (buf.toString('utf8', 0, 4) != 'SOOD') return null;
	if (buf[4] != 2) return null;
	msg.type = buf.toString('utf8', 5, 6);
	let pos = 6;
	while (pos < buf.length) {
	    let len = buf[pos++];
	    if (len == 0) return null;
	    if (pos + len > buf.length) return null;
	    let name = buf.toString('utf8', pos, pos+len);
	    pos += len;
	    len = buf[pos++] << 8;
	    len |= buf[pos++];

	    let val;
	    if (len == 65535)
		val = null;
	    else if (len == 0)
		val = "";
	    else {
		if (pos + len > buf.length) return null;
		val = buf.toString('utf8', pos, pos+len);
		pos += len;
	    }
	    msg.props[name] = val;
	}
	return msg;

    } catch (e) {
	return null;
    }
}

Sood.prototype.query = function(msg) {
    if (!msg['_tid']) {
        msg['_tid'] =  uuid.v4(); 
    }
    
    var buf = new Buffer(65535);
    buf.write("SOOD");
    buf[4] = 2;
    buf.write("Q", 5);

    let pos = 6;
    for (var n in msg) {
	let namelen = buf.write(n, pos+1);
	buf[pos++] = namelen;
	pos += namelen;
	if (msg === undefined || msg === null) {
	    buf[pos++] = 0xff;
	    buf[pos++] = 0xff;
	} else {
	    namelen = buf.write(msg[n], pos+2);
	    buf[pos++] = namelen >> 8;
	    buf[pos++] = namelen & 0xff;
	    pos += namelen;
	}
    }

    for (var ip in this._multicast) {
	if (this._multicast[ip].send_sock) {
//	    console.log('sending on mcast ' + ip);
	    this._multicast[ip].send_sock.send(buf, 0, pos, SOOD_PORT, SOOD_MULTICAST_IP);
//	    console.log('sending on mcast ' + ip + ", bcast " + this._multicast[ip].broadcast);
	    this._multicast[ip].send_sock.send(buf, 0, pos, SOOD_PORT, this._multicast[ip].broadcast);
	}
    }
    if (this._unicast.send_sock) {
//	console.log('sending on unicast');
	this._unicast.send_sock.send(buf, 0, pos, SOOD_PORT, SOOD_MULTICAST_IP);
    }
};

Sood.prototype.initsocket = function(cb) {
    let list = os.networkInterfaces();
    for (var iface in list) {
        list[iface].forEach(e => {
            if (e.family == 'IPv4')
                this._listen_iface(e.address, e.netmask, iface);
        });
    }

    let unicast = this._unicast;
    if (!unicast.send_sock) {
        //	    console.log(`SOOD: new sock: unicast`);
        unicast.send_sock = dgram.createSocket({ type: 'udp4' });
        unicast.send_sock.on('error', (err) => {
            //		console.log(`server error ${ip}`, err);
            unicast.send_sock.close();
        });
        unicast.send_sock.on('close', () => {
            //		console.log(`closed unicast on ${ip}`);
            delete(unicast.send_sock);
        });
        unicast.send_sock.on('message', (msg, rinfo) => {
            msg = _parse(msg, rinfo);
            if (msg) this.emit("message", msg);
        });
        unicast.send_sock.bind({ port: 0 }, () => {
            unicast.send_sock.setBroadcast(true);
            unicast.send_sock.setMulticastTTL(1);
        });
    }

    if (cb) setTimeout(cb, 200);
};
Sood.prototype.start = function(cb) {
    if (!this.interface_timer) this.interface_timer = setInterval(() => this.initsocket(), 5000);
    this.initsocket(cb);
};
Sood.prototype.stop = function() {
    if (this.interface_timer) clearInterval(interface_timer);
    delete(this.interface_timer);
    for (ip in this._multicast) {
	try { this._multicast[ip].recv_sock.close(); } catch (e) { }
	try { this._multicast[ip].send_sock.close(); } catch (e) { }
    }
    try { this._unicast.send_sock.close(); } catch (e) { }
}

Sood.prototype._listen_iface = function(ip, netmask, ifacename) {
    if (!ip) return;

    let iface = this._multicast[ip] = this._multicast[ip] || {};

    if (!iface.recv_sock) {
//	console.log(`SOOD: new sock: recv ${ip}/${ifacename}`);

	iface.recv_sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
	iface.recv_sock.on('error', (err) => {
//	    console.log(`server error ${ip}`, err);
	    iface.recv_sock.close();
	});
	iface.recv_sock.on('close', () => {
//	    console.log(`closed multicast on ${ip}`);
	    delete(iface.recv_sock);
	});
	iface.recv_sock.on('message', (msg, rinfo) => {
	    msg = _parse(msg, rinfo);
	    if (msg) this.emit("message", msg);
	});
	iface.recv_sock.bind({ port: SOOD_PORT }, () => {
	    iface.recv_sock.addMembership(SOOD_MULTICAST_IP, ip);
	});
    }
    if (!iface.send_sock) {
//	console.log(`SOOD: new sock: send ${ip}/${ifacename}`);
	iface.send_sock = dgram.createSocket({ type: 'udp4' });
        iface.broadcast = IP.subnet(ip, netmask).broadcastAddress;
	iface.send_sock.on('error', (err) => {
//	    console.log(`server error ${ip}`, err);
	    iface.send_sock.close();
	});
	iface.send_sock.on('close', () => {
//	    console.log(`closed multicast on ${ip}`);
	    delete(iface.send_sock);
	});
	iface.send_sock.on('message', (msg, rinfo) => {
	    msg = _parse(msg, rinfo);
	    if (msg) this.emit("message", msg);
	});
	iface.send_sock.bind({ port: 0, address: ip }, () => {
	    iface.send_sock.setBroadcast(true);
	    iface.send_sock.setMulticastTTL(1);
	});
    }

}

exports = module.exports = new Sood();
