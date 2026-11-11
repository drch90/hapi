import com.android.apksig.ApkVerifier;
import java.io.File;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/** Verify APK integrity and its pinned signing certificate using the SDK library. */
public final class HapiApkVerifier {
    public static void main(String[] args) {
        try {
            if (args.length != 2) {
                throw new IllegalArgumentException("Expected APK path and certificate SHA-256");
            }
            String expected = args[1].toLowerCase(Locale.ROOT);
            if (!expected.matches("[0-9a-f]{64}")) {
                throw new IllegalArgumentException("Invalid pinned certificate SHA-256");
            }
            ApkVerifier.Result result = new ApkVerifier.Builder(new File(args[0])).build().verify();
            if (!result.isVerified()) {
                throw new IllegalStateException("APK integrity/signature verification failed: " + result.getErrors());
            }
            List<X509Certificate> certificates = new ArrayList<>(result.getSignerCertificates());
            if (certificates.size() > 1) {
                throw new IllegalStateException("Expected one APK signer; found " + certificates.size());
            }
            // Every SDK range must use the fixed certificate, including v3.1 rotation ranges.
            for (var signer : result.getV3SchemeSigners()) {
                certificates.add(signer.getCertificate());
            }
            for (var signer : result.getV31SchemeSigners()) {
                certificates.add(signer.getCertificate());
            }
            Set<String> found = new TreeSet<>();
            MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
            for (X509Certificate certificate : certificates) {
                if (certificate == null) {
                    throw new IllegalStateException("APK signer has no certificate");
                }
                found.add(HexFormat.of().formatHex(sha256.digest(certificate.getEncoded())));
            }
            if (!found.equals(Set.of(expected))) {
                throw new IllegalStateException("APK certificate mismatch: expected " + expected + "; found " + found);
            }
            System.out.println("Verified APK signer SHA-256: " + expected);
        } catch (Exception error) {
            // The verifier receives only the public APK and certificate fingerprint.
            System.err.println("APK signature: " + error.getMessage());
            System.exit(1);
        }
    }
}
