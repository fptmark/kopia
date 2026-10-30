//go:build !no_extra_providers

package sftp

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/ssh"
)

// pipedSSHClient returns an *ssh.Client connected, over a real loopback TCP socket (ssh's version
// exchange deadlocks over the unbuffered net.Pipe: both ends can end up writing their version
// string before either has read the other's), to a minimal test SSH server whose handshake it has
// already completed. serve runs on the server side once the handshake is done, and controls whether
// (and how) it answers anything the client sends after that -- in particular, the global requests
// sshKeepalive sends.
func pipedSSHClient(t *testing.T, serve func(reqs <-chan *ssh.Request)) *ssh.Client {
	t.Helper()

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	signer, err := ssh.NewSignerFromSigner(priv)
	require.NoError(t, err)

	serverConfig := &ssh.ServerConfig{NoClientAuth: true}
	serverConfig.AddHostKey(signer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { ln.Close() }) //nolint:errcheck

	go func() {
		serverSide, err := ln.Accept()
		if err != nil {
			return
		}

		_, _, reqs, err := ssh.NewServerConn(serverSide, serverConfig)
		if err != nil {
			return
		}

		serve(reqs)
	}()

	clientSide, err := net.Dial("tcp", ln.Addr().String())
	require.NoError(t, err)

	conn, chans, reqs, err := ssh.NewClientConn(clientSide, "", &ssh.ClientConfig{
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	})
	require.NoError(t, err)

	return ssh.NewClient(conn, chans, reqs)
}

func withShortKeepalive(t *testing.T, interval, timeout time.Duration) {
	t.Helper()

	origInterval, origTimeout := sshKeepaliveInterval, sshKeepaliveTimeout
	sshKeepaliveInterval, sshKeepaliveTimeout = interval, timeout

	// registered before startKeepalive's own cleanup, so it runs after -- restoring the package
	// vars only once sshKeepalive has actually stopped reading them (t.Cleanup runs LIFO).
	t.Cleanup(func() { sshKeepaliveInterval, sshKeepaliveTimeout = origInterval, origTimeout })
}

// startKeepalive runs sshKeepalive in its own goroutine and joins it on test cleanup, so the
// package-level interval/timeout vars withShortKeepalive restores are never read concurrently with
// that restore (sshKeepalive rereads them on every tick).
func startKeepalive(t *testing.T, client *ssh.Client) (done chan struct{}) {
	t.Helper()

	done = make(chan struct{})
	stopped := make(chan struct{})

	go func() {
		defer close(stopped)
		sshKeepalive(client, done)
	}()

	t.Cleanup(func() {
		select {
		case <-done:
		default:
			close(done)
		}
		<-stopped
	})

	return done
}

func TestSSHKeepaliveClosesAConnectionThatStopsAnswering(t *testing.T) {
	withShortKeepalive(t, 10*time.Millisecond, 30*time.Millisecond)

	// the server completes the handshake, then answers nothing: every request (the keepalive
	// pings included) just sits there, the same as a connection that has gone quiet without
	// actually closing.
	client := pipedSSHClient(t, func(reqs <-chan *ssh.Request) {})

	startKeepalive(t, client)

	closedAt := time.Now()

	require.Eventually(t, func() bool {
		_, _, err := client.SendRequest("probe", true, nil)
		return err != nil
	}, time.Second, 5*time.Millisecond, "a connection that never answers a keepalive must be closed")

	require.WithinDuration(t, closedAt, time.Now(), time.Second,
		"must not take anywhere near the real (unshortened) keepalive timeout to notice")
}

func TestSSHKeepaliveLeavesAnAnsweringConnectionOpen(t *testing.T) {
	withShortKeepalive(t, 10*time.Millisecond, 200*time.Millisecond)

	client := pipedSSHClient(t, func(reqs <-chan *ssh.Request) {
		for req := range reqs {
			req.Reply(true, nil) //nolint:errcheck
		}
	})

	startKeepalive(t, client)

	// several keepalive intervals pass, each one answered.
	time.Sleep(60 * time.Millisecond)

	_, _, err := client.SendRequest("probe", true, nil)
	require.NoError(t, err, "a connection that keeps answering must not be closed")
}
